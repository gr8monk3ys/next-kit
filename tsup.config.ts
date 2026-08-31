import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/rate-limit/index.ts",
    "src/stripe/index.ts",
    "src/auth/clerk.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  // Optional peers: never bundle them, and never fail the build for missing them.
  external: ["stripe", "next", "@clerk/nextjs", "@clerk/nextjs/server"],
});
