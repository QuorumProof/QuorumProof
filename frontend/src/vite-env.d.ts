/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STELLAR_NETWORK?: string;
  readonly VITE_STELLAR_RPC_URL?: string;
  readonly VITE_HORIZON_URL?: string;
  readonly VITE_CONTRACT_QUORUM_PROOF?: string;
  readonly VITE_CONTRACT_SBT_REGISTRY?: string;
  readonly VITE_CONTRACT_ZK_VERIFIER?: string;
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.css' {
  const content: string;
  export default content;
}
