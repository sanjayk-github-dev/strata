import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests fetch real documents on a cold cache; generous but bounded.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    include: ["tests/**/*.test.ts"],
  },
});
