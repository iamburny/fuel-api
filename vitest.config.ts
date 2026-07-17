import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      // Without this, v8 only reports on files a test actually imports —
      // untested files (e.g. a route with zero tests) are silently
      // excluded from the percentage instead of counting as 0%.
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
