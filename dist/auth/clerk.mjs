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
async function requireClerkUserId() {
  const userId = await getClerkUserId();
  if (!userId) throw new UnauthorizedError();
  return userId;
}
function defaultGetRole(user) {
  if (user && typeof user === "object" && "role" in user) {
    const role = user.role;
    return typeof role === "string" ? role : null;
  }
  return null;
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
  async function requireUser() {
    const user = await getUserOrNull();
    if (!user) throw new UnauthorizedError();
    return user;
  }
  async function hasRole(roles) {
    const user = await getUserOrNull();
    if (!user) return false;
    const role = getRole(user);
    if (!role) return false;
    return (Array.isArray(roles) ? roles : [roles]).includes(role);
  }
  async function requireRole(roles) {
    const user = await requireUser();
    const role = getRole(user);
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!role || !allowed.includes(role)) {
      throw new ForbiddenError(
        `Requires one of: ${allowed.join(", ")}`
      );
    }
    return user;
  }
  return { getUserOrNull, requireUser, hasRole, requireRole };
}
function authErrorResponse(error) {
  if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
    return new Response(
      JSON.stringify({ error: error.message, statusCode: error.status }),
      { status: error.status, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}

export { ForbiddenError, UnauthorizedError, authErrorResponse, createClerkAuth, getClerkAuth, getClerkUserId, isAuthenticated, isClerkConfigured, requireClerkUserId, setClerkModule };
