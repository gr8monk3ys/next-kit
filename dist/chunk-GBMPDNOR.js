'use strict';

var chunkXQ42EXWD_js = require('./chunk-XQ42EXWD.js');

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
  if (!userId) throw new chunkXQ42EXWD_js.UnauthorizedError();
  return userId;
}
function createClerkAuth(options) {
  const getRole = options.getRole ?? chunkXQ42EXWD_js.defaultGetRole;
  async function getUserOrNull() {
    if (options.fallback && await options.fallback.enabled()) {
      const fallbackUser = await options.fallback.resolve();
      if (fallbackUser) return fallbackUser;
    }
    const clerkUserId = await getClerkUserId();
    if (!clerkUserId) return null;
    return await options.resolveUser(clerkUserId) ?? null;
  }
  return chunkXQ42EXWD_js.createAuthGuards(async () => {
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

exports.createClerkAuth = createClerkAuth;
exports.getClerkAuth = getClerkAuth;
exports.getClerkUserId = getClerkUserId;
exports.isAuthenticated = isAuthenticated;
exports.isClerkConfigured = isClerkConfigured;
exports.requireClerkUserId = requireClerkUserId;
exports.setClerkModule = setClerkModule;
