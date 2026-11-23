---
status: accepted
date: 2026-11-22
---

# Ship as a GitHub tarball with a committed `dist/` and subpath exports

next-kit is not published to npm; consumers pin a GitHub tag tarball. The tarball is the repo tree, so the CommonJS `require` condition resolves into a committed `dist/` (built by tsup), while the `import` condition points at `src/` so a consumer's `transpilePackages` compiles the TypeScript itself. Each of `rate-limit`, `stripe`, `auth/better-auth` and `auth/clerk` is its own subpath export with an optional peer dependency, and the root entry deliberately omits `stripe`, which imports its package at module scope.

## Consequences

- A stale `dist/` ships broken code, so CI fails when `git diff --exit-code -- dist` is dirty after a build.
- The modules must not import each other (enforced by dependency-cruiser), or an app would need a peer it does not use.
- A consumer-smoke workflow builds this tree and runs a real consumer's suite against it, because a breaking change is otherwise invisible until a consumer re-installs.
