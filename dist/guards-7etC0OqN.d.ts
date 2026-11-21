/**
 * The provider-neutral half of the auth helpers: the 401 / 403 error types,
 * their JSON mapping, and the four guards every provider binding returns.
 * `auth/clerk` and `auth/better-auth` re-export everything here.
 */
/** Thrown when no user is signed in. Carries HTTP 401. */
declare class UnauthorizedError extends Error {
    readonly status = 401;
    constructor(message?: string);
}
/** Thrown when a user is signed in but lacks the required role. Carries 403. */
declare class ForbiddenError extends Error {
    readonly status = 403;
    constructor(message?: string);
}
/** Map an {@link UnauthorizedError} / {@link ForbiddenError} to a JSON response. */
declare function authErrorResponse(error: unknown): Response | null;
interface AuthGuards<TUser> {
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

export { type AuthGuards as A, ForbiddenError as F, UnauthorizedError as U, authErrorResponse as a };
