import { UnauthorizedError, defaultGetRole, createAuthGuards } from './chunk-O77XZMFC.mjs';

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

export { createClerkAuth, getClerkAuth, getClerkUserId, isAuthenticated, isClerkConfigured, requireClerkUserId, setClerkModule };
