/**
 * `@gr8monk3ys/next-kit/auth/clerk`
 *
 * The Clerk half of a server-side auth helper: resolve the signed-in Clerk user
 * id, hand it to whatever loader the app owns, and turn "no user" / "wrong role"
 * into errors instead of `null` checks at every call site.
 *
 * What it deliberately does NOT do is talk to your database. Every app looks
 * up its own user row by `clerkId`, against its own schema, returning its own
 * shape — so that lookup stays in the app as a `resolveUser` function, and only
 * the Clerk plumbing lives here.
 *
 * `@clerk/nextjs` is an optional peer, loaded on first use. Nothing here is
 * typed against a specific Clerk major, so v6 and v7 both work.
 */

/** The subset of Clerk's `auth()` return value this package reads. */
export interface ClerkAuthObject {
  userId: string | null;
  sessionId?: string | null;
  orgId?: string | null;
  orgRole?: string | null;
  [key: string]: unknown;
}

/** The subset of `@clerk/nextjs/server` this package calls. */
export interface ClerkServerModule {
  auth: () => Promise<ClerkAuthObject> | ClerkAuthObject;
  currentUser?: () => Promise<unknown>;
}

let clerkModule: ClerkServerModule | null = null;
let clerkModulePromise: Promise<ClerkServerModule | null> | null = null;

/**
 * Supply the Clerk module directly — for tests, or for an app that imports
 * Clerk from somewhere other than `@clerk/nextjs/server`.
 */
export function setClerkModule(module: ClerkServerModule | null): void {
  clerkModule = module;
  clerkModulePromise = null;
}

async function loadClerk(): Promise<ClerkServerModule | null> {
  if (clerkModule) return clerkModule;
  if (!clerkModulePromise) {
    // The specifier is held in a variable so TypeScript does not try to resolve
    // an optional peer that may not be installed at all.
    const specifier = "@clerk/nextjs/server";
    clerkModulePromise = import(specifier)
      .then((mod) => mod as unknown as ClerkServerModule)
      .catch(() => null);
  }
  return clerkModulePromise;
}

/** True when Clerk's server-side env vars are present. */
export function isClerkConfigured(): boolean {
  return Boolean(
    process.env.CLERK_SECRET_KEY &&
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
}

/**
 * Clerk's auth object, or `null` when Clerk is unconfigured, unavailable, or
 * throws (it does, outside a request scope).
 */
export async function getClerkAuth(): Promise<ClerkAuthObject | null> {
  const mod = await loadClerk();
  if (!mod) return null;
  try {
    return await mod.auth();
  } catch {
    return null;
  }
}

/** The signed-in Clerk user id, without touching your database. */
export async function getClerkUserId(): Promise<string | null> {
  const session = await getClerkAuth();
  return session?.userId ?? null;
}

/** Whether the current request carries a Clerk session. */
export async function isAuthenticated(): Promise<boolean> {
  return (await getClerkUserId()) !== null;
}

/** Thrown when no user is signed in. Carries HTTP 401. */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown when a user is signed in but lacks the required role. Carries 403. */
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** The Clerk user id, or a thrown {@link UnauthorizedError}. */
export async function requireClerkUserId(): Promise<string> {
  const userId = await getClerkUserId();
  if (!userId) throw new UnauthorizedError();
  return userId;
}

export interface ClerkAuthHelpersOptions<TUser> {
  /**
   * Load the app's own user record for a Clerk id. Return `null` when no local
   * record exists — the helpers treat that as "not signed in".
   */
  resolveUser: (clerkUserId: string) => Promise<TUser | null> | TUser | null;
  /**
   * An escape hatch consulted BEFORE Clerk — an `E2E_LOCAL_AUTH` cookie, a
   * local fallback session, anything env-gated. Return `null` to fall through
   * to Clerk.
   */
  fallback?: {
    enabled: () => boolean | Promise<boolean>;
    resolve: () => Promise<TUser | null> | TUser | null;
  };
  /**
   * Pull a role off a resolved user. Defaults to reading a `role` string
   * property, which is what a `User.role` column gives you.
   */
  getRole?: (user: TUser) => string | null | undefined;
}

export interface ClerkAuthHelpers<TUser> {
  /** The current user, or `null` if there isn't one. */
  getUserOrNull(): Promise<TUser | null>;
  /** The current user, or a thrown {@link UnauthorizedError}. */
  requireUser(): Promise<TUser>;
  /** Whether the current user holds any of `roles`. */
  hasRole(roles: string | string[]): Promise<boolean>;
  /**
   * The current user, provided they hold one of `roles`.
   * @throws {@link UnauthorizedError} when signed out,
   *   {@link ForbiddenError} when signed in without the role.
   */
  requireRole(roles: string | string[]): Promise<TUser>;
}

function defaultGetRole(user: unknown): string | null {
  if (user && typeof user === "object" && "role" in user) {
    const role = (user as { role: unknown }).role;
    return typeof role === "string" ? role : null;
  }
  return null;
}

/**
 * Bind the Clerk helpers to one app's user loader.
 *
 * ```ts
 * export const { requireUser, getUserOrNull, requireRole } =
 *   createClerkAuth({
 *     resolveUser: (clerkId) =>
 *       prisma.user.findUnique({ where: { clerkId } }),
 *   });
 * ```
 */
export function createClerkAuth<TUser>(
  options: ClerkAuthHelpersOptions<TUser>,
): ClerkAuthHelpers<TUser> {
  const getRole = options.getRole ?? (defaultGetRole as (u: TUser) => string | null);

  async function getUserOrNull(): Promise<TUser | null> {
    if (options.fallback && (await options.fallback.enabled())) {
      const fallbackUser = await options.fallback.resolve();
      if (fallbackUser) return fallbackUser;
    }

    const clerkUserId = await getClerkUserId();
    if (!clerkUserId) return null;

    return (await options.resolveUser(clerkUserId)) ?? null;
  }

  async function requireUser(): Promise<TUser> {
    const user = await getUserOrNull();
    if (!user) throw new UnauthorizedError();
    return user;
  }

  async function hasRole(roles: string | string[]): Promise<boolean> {
    const user = await getUserOrNull();
    if (!user) return false;
    const role = getRole(user);
    if (!role) return false;
    return (Array.isArray(roles) ? roles : [roles]).includes(role);
  }

  async function requireRole(roles: string | string[]): Promise<TUser> {
    const user = await requireUser();
    const role = getRole(user);
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!role || !allowed.includes(role)) {
      throw new ForbiddenError(
        `Requires one of: ${allowed.join(", ")}`,
      );
    }
    return user;
  }

  return { getUserOrNull, requireUser, hasRole, requireRole };
}

/** Map an {@link UnauthorizedError} / {@link ForbiddenError} to a JSON response. */
export function authErrorResponse(error: unknown): Response | null {
  if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
    return new Response(
      JSON.stringify({ error: error.message, statusCode: error.status }),
      { status: error.status, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}
