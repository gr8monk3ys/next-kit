import { describe, it, expect, vi, beforeEach } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins";

import {
  createBetterAuthGuards,
  activeOrganizationRole,
  authErrorResponse,
  UnauthorizedError,
  ForbiddenError,
  type BetterAuthSession,
} from "../auth/better-auth";
import { ForbiddenError as ClerkForbiddenError } from "../auth/clerk";

type User = { id: string; email: string; role?: string };

const USERS: Record<string, User> = {
  ba_admin: { id: "u-admin", email: "admin@test", role: "admin" },
  ba_member: { id: "u-member", email: "member@test", role: "member" },
  ba_multi: { id: "u-multi", email: "multi@test", role: "member,billing" },
};

function session(userId: string): BetterAuthSession {
  return { user: { id: userId }, session: { id: `s-${userId}` } };
}

function mockAuth(userId: string | null) {
  return {
    api: {
      getSession: vi.fn(async (_: { headers: Headers }) =>
        userId ? session(userId) : null,
      ),
    },
  };
}

const resolveUser = vi.fn(async (s: BetterAuthSession): Promise<User | null> => {
  if (s.user.id === "ba_orphan") return null; // signed in, no local row
  return USERS[s.user.id] ?? null;
});

const headers = new Headers({ cookie: "better-auth.session_token=t" });
const getHeaders = () => headers;

beforeEach(() => {
  resolveUser.mockClear();
});

describe("createBetterAuthGuards", () => {
  it("resolves the app's own user from the session, passing the request headers", async () => {
    const auth = mockAuth("ba_admin");
    const guards = createBetterAuthGuards({ auth, resolveUser, getHeaders });

    await expect(guards.getUserOrNull()).resolves.toEqual(USERS.ba_admin);
    expect(auth.api.getSession).toHaveBeenCalledWith({ headers });
    expect(resolveUser).toHaveBeenCalledWith(session("ba_admin"));
  });

  it("treats a signed-in user with no local row as signed out", async () => {
    const guards = createBetterAuthGuards({ auth: mockAuth("ba_orphan"), resolveUser, getHeaders });

    await expect(guards.getUserOrNull()).resolves.toBeNull();
    await expect(guards.requireUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("does not hit the database when signed out", async () => {
    const guards = createBetterAuthGuards({ auth: mockAuth(null), resolveUser, getHeaders });

    await expect(guards.getUserOrNull()).resolves.toBeNull();
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it("requireUser returns the user when signed in", async () => {
    const guards = createBetterAuthGuards({ auth: mockAuth("ba_member"), resolveUser, getHeaders });
    await expect(guards.requireUser()).resolves.toEqual(USERS.ba_member);
  });

  it("propagates a session lookup failure instead of reporting signed out", async () => {
    const auth = {
      api: { getSession: async () => Promise.reject(new Error("database is down")) },
    };
    const guards = createBetterAuthGuards({ auth, resolveUser, getHeaders });
    await expect(guards.getUserOrNull()).rejects.toThrow("database is down");
  });
});

describe("role checks", () => {
  it("hasRole reads a `role` property by default", async () => {
    const guards = createBetterAuthGuards({ auth: mockAuth("ba_admin"), resolveUser, getHeaders });

    await expect(guards.hasRole("admin")).resolves.toBe(true);
    await expect(guards.hasRole(["moderator", "admin"])).resolves.toBe(true);
    await expect(guards.hasRole("moderator")).resolves.toBe(false);
  });

  it("splits Better Auth's comma-separated role lists", async () => {
    const guards = createBetterAuthGuards({ auth: mockAuth("ba_multi"), resolveUser, getHeaders });

    await expect(guards.hasRole("billing")).resolves.toBe(true);
    await expect(guards.hasRole("member,billing")).resolves.toBe(false);
  });

  it("hasRole is false when signed out", async () => {
    const guards = createBetterAuthGuards({ auth: mockAuth(null), resolveUser, getHeaders });
    await expect(guards.hasRole("admin")).resolves.toBe(false);
  });

  it("requireRole distinguishes 401 from 403", async () => {
    const make = (id: string | null) =>
      createBetterAuthGuards({ auth: mockAuth(id), resolveUser, getHeaders });

    await expect(make(null).requireRole("admin")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(make("ba_member").requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(make("ba_admin").requireRole("admin")).resolves.toEqual(USERS.ba_admin);
  });

  it("passes the session and headers to a custom role getter", async () => {
    const getRole = vi.fn(async (user: User) => (user.email.endsWith("@test") ? "staff" : null));
    const guards = createBetterAuthGuards({
      auth: mockAuth("ba_member"),
      resolveUser,
      getHeaders,
      getRole,
    });

    await expect(guards.requireRole("staff")).resolves.toEqual(USERS.ba_member);
    expect(getRole).toHaveBeenCalledWith(USERS.ba_member, {
      session: session("ba_member"),
      headers,
    });
  });

  it("does not compute roles for requireUser", async () => {
    const getRole = vi.fn(() => "admin");
    const guards = createBetterAuthGuards({
      auth: mockAuth("ba_member"),
      resolveUser,
      getHeaders,
      getRole,
    });

    await guards.requireUser();
    expect(getRole).not.toHaveBeenCalled();
  });

  it("a user with no role never satisfies requireRole", async () => {
    const guards = createBetterAuthGuards({
      auth: mockAuth("ba_roleless"),
      resolveUser: async () => ({ id: "u", email: "e@test" }),
      getHeaders,
    });
    await expect(guards.requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("activeOrganizationRole", () => {
  it("returns no role, without a lookup, when no organization is active", async () => {
    const getActiveMember = vi.fn(async () => ({ role: "owner" }));
    const getRole = activeOrganizationRole({ api: { getActiveMember } });

    await expect(getRole({}, { session: session("x"), headers })).resolves.toBeNull();
    expect(getActiveMember).not.toHaveBeenCalled();
  });
});

describe("authErrorResponse", () => {
  it("is shared with auth/clerk", () => {
    expect(ForbiddenError).toBe(ClerkForbiddenError);
    expect(authErrorResponse(new ClerkForbiddenError())?.status).toBe(403);
    expect(authErrorResponse(new UnauthorizedError())?.status).toBe(401);
    expect(authErrorResponse(new Error("other"))).toBeNull();
  });
});

describe("against a real Better Auth instance", () => {
  function realAuth() {
    return betterAuth({
      secret: "test-secret-that-is-at-least-32-characters-long",
      baseURL: "http://localhost:3000",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
        organization: [],
        member: [],
        invitation: [],
      }),
      emailAndPassword: { enabled: true },
      plugins: [organization()],
    });
  }

  async function signUp(auth: ReturnType<typeof realAuth>, email: string) {
    const { headers: responseHeaders } = await auth.api.signUpEmail({
      body: { email, password: "correct horse battery", name: "Test" },
      returnHeaders: true,
    });
    const cookie = responseHeaders.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("sign-up did not set a session cookie");
    return new Headers({ cookie });
  }

  it("guards on the session cookie and the active organization role", async () => {
    const auth = realAuth();
    const ownerHeaders = await signUp(auth, "owner@example.com");
    const orgGuards = (requestHeaders: Headers) =>
      createBetterAuthGuards({
        auth,
        resolveUser: (s) => s.user,
        getRole: activeOrganizationRole(auth),
        getHeaders: () => requestHeaders,
      });

    await expect(orgGuards(new Headers()).requireUser()).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(orgGuards(ownerHeaders).requireUser()).resolves.toMatchObject({
      email: "owner@example.com",
    });
    await expect(orgGuards(ownerHeaders).hasRole("owner")).resolves.toBe(false);

    await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: ownerHeaders,
    });

    await expect(orgGuards(ownerHeaders).requireRole("owner")).resolves.toMatchObject({
      email: "owner@example.com",
    });
    await expect(orgGuards(ownerHeaders).requireRole("admin")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
