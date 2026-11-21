'use strict';

// src/auth/guards.ts
var UnauthorizedError = class extends Error {
  status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
};
var ForbiddenError = class extends Error {
  status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
};
function authErrorResponse(error) {
  if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
    return new Response(
      JSON.stringify({ error: error.message, statusCode: error.status }),
      { status: error.status, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}
function defaultGetRole(user) {
  if (user && typeof user === "object" && "role" in user) {
    const role = user.role;
    return typeof role === "string" ? role : null;
  }
  return null;
}
function createAuthGuards(load) {
  async function getUserOrNull() {
    return (await load())?.user ?? null;
  }
  async function requireUser() {
    const user = await getUserOrNull();
    if (!user) throw new UnauthorizedError();
    return user;
  }
  async function hasRole(roles) {
    const resolved = await load();
    if (!resolved) return false;
    const held = await resolved.roles();
    return (Array.isArray(roles) ? roles : [roles]).some((r) => held.includes(r));
  }
  async function requireRole(roles) {
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

exports.ForbiddenError = ForbiddenError;
exports.UnauthorizedError = UnauthorizedError;
exports.activeOrganizationRole = activeOrganizationRole;
exports.authErrorResponse = authErrorResponse;
exports.createBetterAuthGuards = createBetterAuthGuards;
