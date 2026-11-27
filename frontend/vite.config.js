import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command, mode }) => {
    if (command === 'build') {
        const env = loadEnv(mode, process.cwd(), '');
        const requiredVars = [
            'VITE_STELLAR_NETWORK',
            'VITE_STELLAR_RPC_URL',
            'VITE_CONTRACT_QUORUM_PROOF',
            'VITE_CONTRACT_SBT_REGISTRY',
            'VITE_CONTRACT_ZK_VERIFIER',
        ];
        const missingVars = requiredVars.filter((name) => {
            const value = env[name]?.trim();
            return !value || value.startsWith('<');
        });
        if (missingVars.length > 0) {
            throw new Error(`[QuorumProof] Production build blocked. Missing required environment variables: ${missingVars.join(', ')}.`);
        }
        const network = env.VITE_STELLAR_NETWORK?.trim();
        if (network && !['testnet', 'mainnet', 'futurenet', 'standalone'].includes(network)) {
            throw new Error(`[QuorumProof] Production build blocked. Invalid VITE_STELLAR_NETWORK "${network}".`);
        }
    }
    return {
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
    };
});
