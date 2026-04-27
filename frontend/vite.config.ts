import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { UserConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["@stellar/stellar-sdk"],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  define: {
    global: "globalThis",
  },
  server: {
    port: 5173,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      exclude: [
        "node_modules/",
        "dist/",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/index.ts",
        "src/main.tsx",
        "src/setupTests.ts",
      ],
      lines: 70,
      functions: 70,
      branches: 65,
      statements: 70,
    },
  },
} as UserConfig);
