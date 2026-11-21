import { defaultGetRole, createAuthGuards } from './chunk-O77XZMFC.mjs';

// src/auth/better-auth.ts
var nextHeadersPromise = null;
async function nextHeaders() {
  if (!nextHeadersPromise) {
    const specifier = "next/headers";
    nextHeadersPromise = import(specifier);
  }
  return (await nextHeadersPromise).headers();
}
function toRoleList(value) {
  const list = typeof value === "string" ? [value] : value ?? [];
  return list.flatMap((role) => role.split(",")).map((r) => r.trim()).filter(Boolean);
}
function activeOrganizationRole(auth) {
  return async (_user, { session, headers }) => {
    if (!session.session.activeOrganizationId) return null;
    const member = await auth.api.getActiveMember({ headers });
    return member?.role ?? null;
  };
}
function createBetterAuthGuards(options) {
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
      roles: async () => toRoleList(await getRole(user, { session, headers }))
    };
  });
}

export { activeOrganizationRole, createBetterAuthGuards };
