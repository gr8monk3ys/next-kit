import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

import {
  createRateLimiter,
  PostgresStore,
  postgresStoreSchema,
  type PostgresQuery,
} from "../rate-limit/index";

// A real Postgres (PGlite, in-process), because the store is one upsert whose
// correctness is entirely in its SQL. A fake would only test the fake.
let db: PGlite;
let query: PostgresQuery;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rowCount(table = "rate_limits"): Promise<number> {
  const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]!.n;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(postgresStoreSchema());
  query = (text, params) =>
    db.query<Record<string, unknown>>(text, params).then((r) => r.rows);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("TRUNCATE rate_limits");
});

describe("PostgresStore", () => {
  it("counts across calls and starts a new window once it expires", async () => {
    const limiter = createRateLimiter({
      store: new PostgresStore(query),
      limit: 2,
      windowMs: 150,
    });

    expect((await limiter.check("ip")).ok).toBe(true);
    expect((await limiter.check("ip")).ok).toBe(true);
    expect((await limiter.check("ip")).ok).toBe(false);

    await sleep(200);
    const next = await limiter.check("ip");
    expect(next.ok).toBe(true);
    expect(next.remaining).toBe(1);
  });

  it("keeps resetAt fixed for the whole window", async () => {
    const store = new PostgresStore(query);

    const first = await store.hit("k", 10_000);
    await sleep(20);
    const second = await store.hit("k", 10_000);

    expect(second.count).toBe(2);
    expect(second.resetAt).toBe(first.resetAt);
    expect(first.resetAt).toBeGreaterThan(Date.now() + 9_000);
  });

  // PGlite serializes statements on its one connection, so this checks that a
  // burst is counted exactly; the race between connections is ON CONFLICT's job.
  it("counts every hit in a burst exactly once", async () => {
    const store = new PostgresStore(query);

    const hits = await Promise.all(Array.from({ length: 25 }, () => store.hit("k", 10_000)));

    expect(hits.map((h) => h.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it("keeps keys apart", async () => {
    const store = new PostgresStore(query);

    await store.hit("a", 10_000);
    await store.hit("a", 10_000);
    const b = await store.hit("b", 10_000);

    expect(b.count).toBe(1);
  });

  it("reset forgets the key", async () => {
    const store = new PostgresStore(query);

    await store.hit("k", 10_000);
    await store.hit("k", 10_000);
    await store.reset("k");

    expect((await store.hit("k", 10_000)).count).toBe(1);
  });

  it("cleanup deletes expired rows and keeps live ones", async () => {
    const store = new PostgresStore(query);

    await store.hit("short", 10);
    await store.hit("long", 60_000);
    await sleep(30);
    await store.cleanup();

    const keys = await db.query<{ key: string }>("SELECT key FROM rate_limits");
    expect(keys.rows.map((r) => r.key)).toEqual(["long"]);
  });

  it("sweeps expired rows from hit once the interval has passed", async () => {
    const store = new PostgresStore(query, { cleanupIntervalMs: 20 });

    await store.hit("short", 10);
    await sleep(40);
    await store.hit("other", 60_000);

    expect(await rowCount()).toBe(1);
  });

  it("never sweeps from hit when cleanupIntervalMs is 0", async () => {
    const spy = vi.fn(query);
    const store = new PostgresStore(spy, { cleanupIntervalMs: 0 });

    await store.hit("k", 10);
    await sleep(20);
    await store.hit("k", 10);

    expect(spy.mock.calls.every(([text]) => !text.includes("DELETE"))).toBe(true);
  });

  it("uses a custom, schema-qualified table", async () => {
    await db.exec("CREATE SCHEMA IF NOT EXISTS app");
    await db.exec(postgresStoreSchema("app.limits"));
    const store = new PostgresStore(query, { table: "app.limits" });

    await store.hit("k", 10_000);

    expect(await rowCount("app.limits")).toBe(1);
    expect(await rowCount()).toBe(0);
  });

  it("rejects a table name that is not a plain identifier", () => {
    expect(() => new PostgresStore(query, { table: "x; DROP TABLE users" })).toThrow(
      "Invalid rate-limit table name",
    );
    expect(() => postgresStoreSchema('"quoted"')).toThrow("Invalid rate-limit table name");
  });

  it("accepts numbers returned as strings, as pg does for numeric types", async () => {
    const stringly: PostgresQuery = async () => [{ count: "3", reset_at_ms: "1767225600000.4" }];

    expect(await new PostgresStore(stringly).hit("k", 1_000)).toEqual({
      count: 3,
      resetAt: 1767225600000,
    });
  });

  it("fails open when the query throws, and reports the error", async () => {
    const onErrorLog = vi.fn();
    const broken: PostgresQuery = () => Promise.reject(new Error("ECONNREFUSED"));
    const limiter = createRateLimiter({
      store: new PostgresStore(broken, { onErrorLog }),
      limit: 1,
      windowMs: 1_000,
    });

    expect((await limiter.check("k")).ok).toBe(true);
    expect((await limiter.check("k")).ok).toBe(true);
    expect(onErrorLog).toHaveBeenCalledTimes(2);
  });

  it("fails closed when told to", async () => {
    const broken: PostgresQuery = () => Promise.reject(new Error("ECONNREFUSED"));
    const store = new PostgresStore(broken, { onError: "closed" });

    await expect(store.hit("k", 1_000)).rejects.toThrow("ECONNREFUSED");
  });
});

// The race PGlite cannot stage: many connections upserting one key at once.
// CI runs it against a Postgres service; locally, set NEXT_KIT_PG_URL.
const pgUrl = process.env.NEXT_KIT_PG_URL;

describe.runIf(pgUrl)("PostgresStore on a real server (pg pool)", () => {
  let pool: Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: pgUrl, max: 20 });
    await pool.query(postgresStoreSchema("pool_rate_limits"));
    store = new PostgresStore((text, params) => pool.query(text, params).then((r) => r.rows), {
      table: "pool_rate_limits",
      onError: "closed",
    });
  });

  afterAll(async () => {
    await pool?.query("DROP TABLE IF EXISTS pool_rate_limits");
    await pool?.end();
  });

  it("counts concurrent hits from many connections exactly once each", async () => {
    const hits = await Promise.all(Array.from({ length: 300 }, () => store.hit("burst", 60_000)));

    expect(hits.map((h) => h.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 300 }, (_, i) => i + 1),
    );
    expect(new Set(hits.map((h) => h.resetAt)).size).toBe(1);
  });

  it("starts exactly one new window when a concurrent burst lands after expiry", async () => {
    await Promise.all(Array.from({ length: 50 }, () => store.hit("roll", 100)));
    await sleep(150);
    const hits = await Promise.all(Array.from({ length: 50 }, () => store.hit("roll", 100)));

    expect(hits.map((h) => h.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });
});
