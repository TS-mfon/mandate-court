import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "apps/web"),
      // The sdk publishes exports pointing at dist/, so tests would otherwise
      // need a build to have run first. Resolve it from source instead.
      "@mandate-court/sdk": resolve(process.cwd(), "packages/sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
