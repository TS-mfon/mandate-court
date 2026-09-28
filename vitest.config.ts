import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "apps/web"),
    },
  },
  test: {
    environment: "node",
  },
});
