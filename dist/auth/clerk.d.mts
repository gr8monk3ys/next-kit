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
 *
 * ## Where the throwing guards belong
 *
 * `requireUser` and `requireRole` **throw**; they do not redirect. That makes
 * them right for route handlers and wrong for Server Components:
 *
 * - **Route handler / API route** — catch and map. `authErrorResponse(error)`
 *   turns the two error types into a 401 / 403 JSON response and returns `null`
 *   for anything else, so you can re-throw what you did not recognise:
 *
 *   ```ts
 *   export async function GET() {
 *     try {
 *       const user = await requireUser();
 *       return Response.json(await load(user));
 *     } catch (error) {
 *       const response = authErrorResponse(error);
 *       if (response) return response;
 *       throw error;
 *     }
 *   }
 *   ```
 *
 * - **Server Component / page** — do NOT let the throw escape. An uncaught
 *   throw renders the error boundary and the visitor gets a 500, not a
 *   sign-in prompt. Use `getUserOrNull()` and redirect yourself:
 *
 *   ```ts
 *   const user = await getUserOrNull();
 *   if (!user) redirect("/sign-in");
 *   ```
 */
/** The subset of Clerk's `auth()` return value this package reads. */
interface ClerkAuthObject {
    userId: string | null;
    sessionId?: string | null;
    orgId?: string | null;
    orgRole?: string | null;
    [key: string]: unknown;
}
/** The subset of `@clerk/nextjs/server` this package calls. */
interface ClerkServerModule {
    auth: () => Promise<ClerkAuthObject> | ClerkAuthObject;
    currentUser?: () => Promise<unknown>;
}
/**
 * Supply the Clerk module directly — for tests, or for an app that imports
 * Clerk from somewhere other than `@clerk/nextjs/server`.
 */
declare function setClerkModule(module: ClerkServerModule | null): void;
/** True when Clerk's server-side env vars are present. */
declare function isClerkConfigured(): boolean;
/**
 * Clerk's auth object, or `null` when Clerk is unconfigured, unavailable, or
 * throws (it does, outside a request scope).
 */
declare function getClerkAuth(): Promise<ClerkAuthObject | null>;
/** The signed-in Clerk user id, without touching your database. */
declare function getClerkUserId(): Promise<string | null>;
/** Whether the current request carries a Clerk session. */
declare function isAuthenticated(): Promise<boolean>;
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
/** The Clerk user id, or a thrown {@link UnauthorizedError}. */
declare function requireClerkUserId(): Promise<string>;
interface ClerkAuthHelpersOptions<TUser> {
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
interface ClerkAuthHelpers<TUser> {
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
     * Throws, so the same rule applies as {@link ClerkAuthHelpers.requireUser}:
     * map it with {@link authErrorResponse} in a route handler; in a Server
     * Component use `hasRole()` and redirect yourself.
     *
     * @throws {@link UnauthorizedError} (401) when signed out,
     *   {@link ForbiddenError} (403) when signed in without the role.
     */
    requireRole(roles: string | string[]): Promise<TUser>;
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
declare function createClerkAuth<TUser>(options: ClerkAuthHelpersOptions<TUser>): ClerkAuthHelpers<TUser>;
/** Map an {@link UnauthorizedError} / {@link ForbiddenError} to a JSON response. */
declare function authErrorResponse(error: unknown): Response | null;

export { type ClerkAuthHelpers, type ClerkAuthHelpersOptions, type ClerkAuthObject, type ClerkServerModule, ForbiddenError, UnauthorizedError, authErrorResponse, createClerkAuth, getClerkAuth, getClerkUserId, isAuthenticated, isClerkConfigured, requireClerkUserId, setClerkModule };
