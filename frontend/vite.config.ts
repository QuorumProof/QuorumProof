import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { UserConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      buffer: path.resolve(__dirname, 'node_modules/buffer/'),
    },
  },
  optimizeDeps: {
    include: ['@stellar/stellar-sdk', '@creit.tech/stellar-wallets-kit', 'buffer'],
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
    setupFiles: ['./src/setupTests.ts'],
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
