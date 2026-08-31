import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  setClerkModule,
  getClerkAuth,
  getClerkUserId,
  isAuthenticated,
  isClerkConfigured,
  requireClerkUserId,
  createClerkAuth,
  authErrorResponse,
  UnauthorizedError,
  ForbiddenError,
  type ClerkServerModule,
} from "../auth/clerk";

type User = { id: string; email: string; role?: string };

const USERS: Record<string, User> = {
  clerk_admin: { id: "u-admin", email: "admin@test", role: "admin" },
  clerk_member: { id: "u-member", email: "member@test", role: "member" },
};

function mockClerk(userId: string | null): ClerkServerModule {
  return { auth: vi.fn(async () => ({ userId })) };
}

const resolveUser = vi.fn(async (clerkId: string): Promise<User | null> => {
  if (clerkId === "clerk_orphan") return null; // signed in, no local row
  return USERS[clerkId] ?? null;
});

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resolveUser.mockClear();
  setClerkModule(null);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  setClerkModule(null);
});

describe("Clerk session plumbing", () => {
  it("reads userId off Clerk's auth object", async () => {
    setClerkModule(mockClerk("clerk_admin"));
    await expect(getClerkUserId()).resolves.toBe("clerk_admin");
    await expect(isAuthenticated()).resolves.toBe(true);
  });

  it("returns null when signed out", async () => {
    setClerkModule(mockClerk(null));
    await expect(getClerkUserId()).resolves.toBeNull();
    await expect(isAuthenticated()).resolves.toBe(false);
  });

  it("returns null rather than throwing when auth() blows up outside a request", async () => {
    setClerkModule({
      auth: () => {
        throw new Error("auth() was called outside a request scope");
      },
    });
    await expect(getClerkAuth()).resolves.toBeNull();
    await expect(getClerkUserId()).resolves.toBeNull();
  });

  it("requireClerkUserId throws UnauthorizedError (401) when signed out", async () => {
    setClerkModule(mockClerk(null));
    await expect(requireClerkUserId()).rejects.toBeInstanceOf(UnauthorizedError);

    setClerkModule(mockClerk("clerk_member"));
    await expect(requireClerkUserId()).resolves.toBe("clerk_member");
  });

  it("isClerkConfigured checks both server-side env vars", () => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    expect(isClerkConfigured()).toBe(false);

    process.env.CLERK_SECRET_KEY = "sk_test";
    expect(isClerkConfigured()).toBe(false);

    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test";
    expect(isClerkConfigured()).toBe(true);
  });
});

describe("createClerkAuth", () => {
  it("resolves the app's own user from the Clerk id", async () => {
    setClerkModule(mockClerk("clerk_admin"));
    const auth = createClerkAuth({ resolveUser });

    await expect(auth.getUserOrNull()).resolves.toEqual(USERS.clerk_admin);
    expect(resolveUser).toHaveBeenCalledWith("clerk_admin");
  });

  it("treats a signed-in user with no local row as signed out", async () => {
    setClerkModule(mockClerk("clerk_orphan"));
    const auth = createClerkAuth({ resolveUser });

    await expect(auth.getUserOrNull()).resolves.toBeNull();
    await expect(auth.requireUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("does not hit the database when signed out", async () => {
    setClerkModule(mockClerk(null));
    const auth = createClerkAuth({ resolveUser });

    await expect(auth.getUserOrNull()).resolves.toBeNull();
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it("requireUser returns the user when signed in", async () => {
    setClerkModule(mockClerk("clerk_member"));
    const auth = createClerkAuth({ resolveUser });
    await expect(auth.requireUser()).resolves.toEqual(USERS.clerk_member);
  });
});

describe("role checks", () => {
  it("hasRole reads a `role` property by default", async () => {
    setClerkModule(mockClerk("clerk_admin"));
    const auth = createClerkAuth({ resolveUser });

    await expect(auth.hasRole("admin")).resolves.toBe(true);
    await expect(auth.hasRole(["moderator", "admin"])).resolves.toBe(true);
    await expect(auth.hasRole("moderator")).resolves.toBe(false);
  });

  it("hasRole is false when signed out", async () => {
    setClerkModule(mockClerk(null));
    await expect(createClerkAuth({ resolveUser }).hasRole("admin")).resolves.toBe(false);
  });

  it("requireRole distinguishes 401 from 403", async () => {
    const auth = createClerkAuth({ resolveUser });

    setClerkModule(mockClerk(null));
    await expect(auth.requireRole("admin")).rejects.toBeInstanceOf(UnauthorizedError);

    setClerkModule(mockClerk("clerk_member"));
    await expect(auth.requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);

    setClerkModule(mockClerk("clerk_admin"));
    await expect(auth.requireRole("admin")).resolves.toEqual(USERS.clerk_admin);
  });

  it("accepts a custom role extractor", async () => {
    setClerkModule(mockClerk("clerk_member"));
    const auth = createClerkAuth<User>({
      resolveUser,
      getRole: (user) => (user.email.endsWith("@test") ? "staff" : null),
    });

    await expect(auth.hasRole("staff")).resolves.toBe(true);
    await expect(auth.requireRole("staff")).resolves.toEqual(USERS.clerk_member);
  });

  it("a user with no role never satisfies requireRole", async () => {
    setClerkModule(mockClerk("clerk_roleless"));
    const auth = createClerkAuth({
      resolveUser: async () => ({ id: "u", email: "e@test" }) as User,
    });
    await expect(auth.requireRole("admin")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("fallback session", () => {
  it("is consulted before Clerk and short-circuits it", async () => {
    const clerk = mockClerk("clerk_admin");
    setClerkModule(clerk);

    const auth = createClerkAuth({
      resolveUser,
      fallback: {
        enabled: () => true,
        resolve: async () => ({ id: "e2e", email: "e2e@local", role: "admin" }),
      },
    });

    await expect(auth.getUserOrNull()).resolves.toMatchObject({ id: "e2e" });
    expect(clerk.auth).not.toHaveBeenCalled();
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it("falls through to Clerk when disabled", async () => {
    setClerkModule(mockClerk("clerk_admin"));
    const resolveFallback = vi.fn(async () => null);

    const auth = createClerkAuth({
      resolveUser,
      fallback: { enabled: () => false, resolve: resolveFallback },
    });

    await expect(auth.getUserOrNull()).resolves.toEqual(USERS.clerk_admin);
    expect(resolveFallback).not.toHaveBeenCalled();
  });

  it("falls through to Clerk when enabled but it resolves nothing", async () => {
    setClerkModule(mockClerk("clerk_member"));
    const auth = createClerkAuth({
      resolveUser,
      fallback: { enabled: () => true, resolve: async () => null },
    });

    await expect(auth.getUserOrNull()).resolves.toEqual(USERS.clerk_member);
  });
});

describe("authErrorResponse", () => {
  it("maps the two auth errors to 401 / 403 and everything else to null", async () => {
    const unauthorized = authErrorResponse(new UnauthorizedError());
    expect(unauthorized?.status).toBe(401);

    const forbidden = authErrorResponse(new ForbiddenError("Requires one of: admin"));
    expect(forbidden?.status).toBe(403);
    await expect(forbidden!.json()).resolves.toMatchObject({
      error: "Requires one of: admin",
      statusCode: 403,
    });

    expect(authErrorResponse(new Error("database is on fire"))).toBeNull();
  });
});
