/**
 * The provider-neutral half of the auth helpers: the 401 / 403 error types,
 * their JSON mapping, and the four guards every provider binding returns.
 * `auth/clerk` and `auth/better-auth` re-export everything here.
 */

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

/** Reads a `role` string property, which is what a `User.role` column gives you. */
export function defaultGetRole(user: unknown): string | null {
  if (user && typeof user === "object" && "role" in user) {
    const role = (user as { role: unknown }).role;
    return typeof role === "string" ? role : null;
  }
  return null;
}

export interface AuthGuards<TUser> {
  /** The current user, or `null` if there isn't one. */
  getUserOrNull(): Promise<TUser | null>;
  /**
   * The current user, or a thrown {@link UnauthorizedError} (401).
   *
   * For route handlers, pair with {@link authErrorResponse}. In a Server
   * Component prefer `getUserOrNull()` + `redirect()` — an uncaught throw there
   * is a 500, not a sign-in redirect.
   */
  requireUser(): Promise<TUser>;
  /** Whether the current user holds any of `roles`. */
  hasRole(roles: string | string[]): Promise<boolean>;
  /**
   * The current user, provided they hold one of `roles`.
   *
   * @throws {@link UnauthorizedError} (401) when signed out,
   *   {@link ForbiddenError} (403) when signed in without the role.
   */
  requireRole(roles: string | string[]): Promise<TUser>;
}

/** What a provider binding resolves per request: the user, and their roles on demand. */
export interface ResolvedAuth<TUser> {
  user: TUser;
  roles: () => Promise<readonly string[]>;
}

/** Build the four guards from a provider's per-request loader. */
export function createAuthGuards<TUser>(
  load: () => Promise<ResolvedAuth<TUser> | null>,
): AuthGuards<TUser> {
  async function getUserOrNull(): Promise<TUser | null> {
    return (await load())?.user ?? null;
  }

  async function requireUser(): Promise<TUser> {
    const user = await getUserOrNull();
    if (!user) throw new UnauthorizedError();
    return user;
  }

  async function hasRole(roles: string | string[]): Promise<boolean> {
    const resolved = await load();
    if (!resolved) return false;
    const held = await resolved.roles();
    return (Array.isArray(roles) ? roles : [roles]).some((r) => held.includes(r));
  }

  async function requireRole(roles: string | string[]): Promise<TUser> {
    const resolved = await load();
    if (!resolved) throw new UnauthorizedError();
    const held = await resolved.roles();
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.some((r) => held.includes(r))) {
      throw new ForbiddenError(`Requires one of: ${allowed.join(", ")}`);
    }
    return resolved.user;
  }

  return { getUserOrNull, requireUser, hasRole, requireRole };
}
