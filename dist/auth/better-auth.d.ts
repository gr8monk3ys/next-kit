import { A as AuthGuards } from '../guards-7etC0OqN.js';
export { F as ForbiddenError, U as UnauthorizedError, a as authErrorResponse } from '../guards-7etC0OqN.js';

/**
 * `@gr8monk3ys/next-kit/auth/better-auth`
 *
 * Auth guards for an app that runs Better Auth: read the session with the
 * app's own `auth` instance, hand it to whatever loader the app owns, and turn
 * "no user" / "wrong role" into errors instead of `null` checks at every call
 * site.
 *
 * The app owns the Better Auth instance, its database, its schema and its
 * routes; this module only calls `auth.api.getSession`. It never imports
 * `better-auth` itself, so it is typed structurally against the instance
 * rather than against one Better Auth release.
 *
 * Request headers come from `next/headers`, loaded on first use. Pass
 * `getHeaders` to supply them yourself (tests, or code outside Next.js).
 *
 * `requireUser` and `requireRole` throw rather than redirect, exactly like
 * `auth/clerk`: map them with `authErrorResponse` in a route handler, and use
 * `getUserOrNull()` / `hasRole()` plus `redirect()` in a Server Component.
 */

/** The subset of a Better Auth session this module reads. */
interface BetterAuthSession {
    user: {
        id: string;
    };
    session: {
        id: string;
        activeOrganizationId?: string | null;
    };
}
/** The subset of a Better Auth instance (`betterAuth({...})`) this module calls. */
interface BetterAuthServer<TSession extends BetterAuthSession> {
    api: {
        getSession(context: {
            headers: Headers;
        }): Promise<TSession | null>;
    };
}
/** What a role getter receives besides the resolved user. */
interface BetterAuthRoleContext<TSession extends BetterAuthSession> {
    session: TSession;
    headers: Headers;
}
/** One role, a Better Auth comma-separated role list, or several roles. */
type RoleValue = string | readonly string[] | null | undefined;
interface BetterAuthGuardsOptions<TUser, TSession extends BetterAuthSession> {
    /** The app's Better Auth instance. */
    auth: BetterAuthServer<TSession>;
    /**
     * Load the app's own user record for a session. Return `null` when no local
     * record exists — the guards treat that as "not signed in". To use Better
     * Auth's user as-is, return `session.user`.
     */
    resolveUser: (session: TSession) => Promise<TUser | null> | TUser | null;
    /**
     * The roles `hasRole` / `requireRole` check. Defaults to the resolved user's
     * `role` string. For organization roles, pass
     * {@link activeOrganizationRole}`(auth)`.
     */
    getRole?: (user: TUser, context: BetterAuthRoleContext<TSession>) => RoleValue | Promise<RoleValue>;
    /** Request headers. Defaults to `headers()` from `next/headers`. */
    getHeaders?: () => Headers | Promise<Headers>;
}
/**
 * A `getRole` that reads the user's role in the session's active organization
 * (Better Auth's organization plugin). No active organization means no role.
 */
declare function activeOrganizationRole(auth: {
    api: {
        getActiveMember(context: {
            headers: Headers;
        }): Promise<{
            role: string;
        } | null>;
    };
}): (user: unknown, context: BetterAuthRoleContext<BetterAuthSession>) => Promise<string | null>;
/**
 * Bind the guards to one app's Better Auth instance and user loader.
 *
 * ```ts
 * export const { requireUser, getUserOrNull, requireRole, hasRole } =
 *   createBetterAuthGuards({
 *     auth,
 *     resolveUser: (session) => session.user,
 *   });
 * ```
 */
declare function createBetterAuthGuards<TUser, TSession extends BetterAuthSession>(options: BetterAuthGuardsOptions<TUser, TSession>): AuthGuards<TUser>;

export { AuthGuards, type BetterAuthGuardsOptions, type BetterAuthRoleContext, type BetterAuthServer, type BetterAuthSession, type RoleValue, activeOrganizationRole, createBetterAuthGuards };
