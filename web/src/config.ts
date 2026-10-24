import type { Address } from 'viem';

function env(name: keyof ImportMetaEnv): string | undefined {
  const v = import.meta.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim().replace(/\/$/, '') : undefined;
}

export const config = {
  approvalUrl: env('VITE_APPROVAL_URL'),
  attestorUrl: env('VITE_ATTESTOR_URL'),
  agentToolsUrl: env('VITE_AGENT_TOOLS_URL'),
  runnerUrl: env('VITE_RUNNER_URL'),
  chainId: Number(env('VITE_CHAIN_ID') ?? 84532),
  rpcUrl: env('VITE_RPC_URL'),
  walletAddress: env('VITE_WALLET_ADDRESS') as Address | undefined,
  factoryAddress: env('VITE_FACTORY_ADDRESS') as Address | undefined,
  entryPointAddress: (env('VITE_ENTRYPOINT_ADDRESS') ??
    '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108') as Address,
} as const;

export const EXPLORERS: Record<number, { name: string; url: string }> = {
  8453: { name: 'Basescan', url: 'https://basescan.org' },
  84532: { name: 'Basescan Sepolia', url: 'https://sepolia.basescan.org' },
  31337: { name: 'Local', url: '' },
};

export function explorerTx(hash: string, chainId = config.chainId): string | undefined {
  const e = EXPLORERS[chainId];
  return e && e.url ? `${e.url}/tx/${hash}` : undefined;
}
export function explorerAddress(addr: string, chainId = config.chainId): string | undefined {
  const e = EXPLORERS[chainId];
  return e && e.url ? `${e.url}/address/${addr}` : undefined;
}
export const CHAIN_NAMES: Record<number, string> = {
  8453: 'Base',
  84532: 'Base Sepolia',
  31337: 'Local fork',
};
