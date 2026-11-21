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

import { createAuthGuards, defaultGetRole, type AuthGuards } from "./guards";

export {
  UnauthorizedError,
  ForbiddenError,
  authErrorResponse,
  type AuthGuards,
} from "./guards";

/** The subset of a Better Auth session this module reads. */
export interface BetterAuthSession {
  user: { id: string };
  session: { id: string; activeOrganizationId?: string | null };
}

/** The subset of a Better Auth instance (`betterAuth({...})`) this module calls. */
export interface BetterAuthServer<TSession extends BetterAuthSession> {
  api: {
    getSession(context: { headers: Headers }): Promise<TSession | null>;
  };
}

/** What a role getter receives besides the resolved user. */
export interface BetterAuthRoleContext<TSession extends BetterAuthSession> {
  session: TSession;
  headers: Headers;
}

/** One role, a Better Auth comma-separated role list, or several roles. */
export type RoleValue = string | readonly string[] | null | undefined;

export interface BetterAuthGuardsOptions<
  TUser,
  TSession extends BetterAuthSession,
> {
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
  getRole?: (
    user: TUser,
    context: BetterAuthRoleContext<TSession>,
  ) => RoleValue | Promise<RoleValue>;
  /** Request headers. Defaults to `headers()` from `next/headers`. */
  getHeaders?: () => Headers | Promise<Headers>;
}

interface NextHeadersModule {
  headers: () => Headers | Promise<Headers>;
}

let nextHeadersPromise: Promise<NextHeadersModule> | null = null;

async function nextHeaders(): Promise<Headers> {
  if (!nextHeadersPromise) {
    // The specifier is held in a variable so TypeScript does not try to resolve
    // an optional peer that may not be installed at all.
    const specifier = "next/headers";
    nextHeadersPromise = import(specifier);
  }
  return (await nextHeadersPromise).headers();
}

/** Better Auth stores several roles as one comma-separated string. */
function toRoleList(value: RoleValue): string[] {
  const list: readonly string[] =
    typeof value === "string" ? [value] : (value ?? []);
  return list.flatMap((role) => role.split(",")).map((r) => r.trim()).filter(Boolean);
}

/**
 * A `getRole` that reads the user's role in the session's active organization
 * (Better Auth's organization plugin). No active organization means no role.
 */
export function activeOrganizationRole(auth: {
  api: {
    getActiveMember(context: { headers: Headers }): Promise<{ role: string } | null>;
  };
}): (user: unknown, context: BetterAuthRoleContext<BetterAuthSession>) => Promise<string | null> {
  return async (_user, { session, headers }) => {
    if (!session.session.activeOrganizationId) return null;
    const member = await auth.api.getActiveMember({ headers });
    return member?.role ?? null;
  };
}

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
export function createBetterAuthGuards<TUser, TSession extends BetterAuthSession>(
  options: BetterAuthGuardsOptions<TUser, TSession>,
): AuthGuards<TUser> {
  const getHeaders = options.getHeaders ?? nextHeaders;
  const getRole = options.getRole ?? defaultGetRole;

  return createAuthGuards(async () => {
    const headers = await getHeaders();
    const session = await options.auth.api.getSession({ headers });
    if (!session) return null;

    const user = await options.resolveUser(session);
    if (!user) return null;

    return {
      user,
      roles: async () => toRoleList(await getRole(user, { session, headers })),
    };
  });
}
