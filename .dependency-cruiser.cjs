/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Dependency cycles make modules impossible to load or reason about in isolation.",
      from: {},
      to: { circular: true },
    },
    {
      name: "modules-are-independent",
      severity: "error",
      comment:
        "rate-limit, auth and stripe are separate subpath exports with separate optional peers. A cross-import would force an app to install a peer it does not use.",
      from: { path: "^src/(rate-limit|auth|stripe)/" },
      to: {
        path: "^src/(rate-limit|auth|stripe)/",
        pathNot: "^src/$1/",
      },
    },
    {
      name: "tests-through-entrypoints",
      severity: "error",
      comment:
        "Tests exercise the public subpath entry points, not a module's private helpers. Import from the module's index (or the auth provider files).",
      from: { path: "^src/__tests__/" },
      to: { path: "^src/(rate-limit/(store|client-id)|auth/guards)\\.ts$" },
    },
    {
      name: "src-does-not-import-tests",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/__tests__/" },
      to: { path: "^src/__tests__/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
