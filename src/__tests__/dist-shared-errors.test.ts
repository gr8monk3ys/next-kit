import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as esmIndex from "../../dist/index.mjs";
import * as esmClerk from "../../dist/auth/clerk.mjs";
import * as esmBetterAuth from "../../dist/auth/better-auth.mjs";

// The guards module is bundled into several entry points. If the build stops
// emitting it as one shared chunk, each subpath gets its own error classes and
// authErrorResponse from one subpath no longer recognises errors from another.
const require = createRequire(import.meta.url);

type GuardExports = {
  UnauthorizedError: new (message?: string) => Error;
  ForbiddenError: new (message?: string) => Error;
  authErrorResponse: (error: unknown) => Response | null;
};

function assertShared(first: GuardExports, ...rest: GuardExports[]) {
  for (const mod of rest) {
    expect(mod.UnauthorizedError).toBe(first.UnauthorizedError);
    expect(mod.ForbiddenError).toBe(first.ForbiddenError);
  }
  const all = [first, ...rest];
  for (const thrower of all) {
    for (const responder of all) {
      expect(responder.authErrorResponse(new thrower.ForbiddenError())?.status).toBe(403);
      expect(responder.authErrorResponse(new thrower.UnauthorizedError())?.status).toBe(401);
    }
  }
}

describe("dist auth entry points share one set of error classes (rebuild dist with `bun run build` if this fails)", () => {
  it("CommonJS", () => {
    assertShared(
      require("../../dist/index.js") as GuardExports,
      require("../../dist/auth/clerk.js") as GuardExports,
      require("../../dist/auth/better-auth.js") as GuardExports,
    );
  });

  it("ESM", () => {
    assertShared(esmIndex, esmClerk, esmBetterAuth);
  });
});
