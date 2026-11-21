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

// src/auth/clerk.ts
var clerkModule = null;
var clerkModulePromise = null;
function setClerkModule(module) {
  clerkModule = module;
  clerkModulePromise = null;
}
async function loadClerk() {
  if (clerkModule) return clerkModule;
  if (!clerkModulePromise) {
    const specifier = "@clerk/nextjs/server";
    clerkModulePromise = import(specifier).then((mod) => mod).catch(() => null);
  }
  return clerkModulePromise;
}
function isClerkConfigured() {
  return Boolean(
    process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  );
}
async function getClerkAuth() {
  const mod = await loadClerk();
  if (!mod) return null;
  try {
    return await mod.auth();
  } catch {
    return null;
  }
}
async function getClerkUserId() {
  const session = await getClerkAuth();
  return session?.userId ?? null;
}
async function isAuthenticated() {
  return await getClerkUserId() !== null;
}
async function requireClerkUserId() {
  const userId = await getClerkUserId();
  if (!userId) throw new UnauthorizedError();
  return userId;
}
function createClerkAuth(options) {
  const getRole = options.getRole ?? defaultGetRole;
  async function getUserOrNull() {
    if (options.fallback && await options.fallback.enabled()) {
      const fallbackUser = await options.fallback.resolve();
      if (fallbackUser) return fallbackUser;
    }
    const clerkUserId = await getClerkUserId();
    if (!clerkUserId) return null;
    return await options.resolveUser(clerkUserId) ?? null;
  }
  return createAuthGuards(async () => {
    const user = await getUserOrNull();
    if (!user) return null;
    return {
      user,
      roles: async () => {
        const role = getRole(user);
        return role ? [role] : [];
      }
    };
  });
}

exports.ForbiddenError = ForbiddenError;
exports.UnauthorizedError = UnauthorizedError;
exports.authErrorResponse = authErrorResponse;
exports.createClerkAuth = createClerkAuth;
exports.getClerkAuth = getClerkAuth;
exports.getClerkUserId = getClerkUserId;
exports.isAuthenticated = isAuthenticated;
exports.isClerkConfigured = isClerkConfigured;
exports.requireClerkUserId = requireClerkUserId;
exports.setClerkModule = setClerkModule;
