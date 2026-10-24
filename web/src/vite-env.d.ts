/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APPROVAL_URL?: string;
  readonly VITE_ATTESTOR_URL?: string;
  readonly VITE_AGENT_TOOLS_URL?: string;
  readonly VITE_RUNNER_URL?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_WALLET_ADDRESS?: string;
  readonly VITE_FACTORY_ADDRESS?: string;
  readonly VITE_ENTRYPOINT_ADDRESS?: string;
  readonly VITE_SALT?: string;
  readonly VITE_USDC_ADDRESS?: string;
  readonly VITE_AGENT_ADDRESS?: string;
  readonly VITE_ATTESTOR_ADDRESS?: string;
  readonly VITE_WATCHER_ADDRESS?: string;
  readonly VITE_MERCHANT_ADDRESS?: string;
  readonly VITE_DAILY_USDC?: string;
  readonly VITE_FUND_USDC?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
}
interface Window {
  ethereum?: EthereumProvider;
}
