/**
 * Chains the live demo knows. Browser-safe (no node imports).
 *
 *   base-sepolia  THE DEMO: Base Sepolia testnet, real Circle test USDC (EIP-3009), real EntryPoint v0.8,
 *                 real services. Free test money from faucets.
 *   anvil         PRE-FLIGHT REHEARSAL ONLY (scripts/live/rehearse.ts): a local chain with a stand-in token.
 *                 Never presented as the demo.
 *   base          Base mainnet. Refused everywhere unless --allow-mainnet is passed; the contracts are
 *                 unaudited, so the account may hold ~1 USDC at most.
 */
export interface ChainInfo {
  key: string;
  chainId: number;
  name: string;
  rpc: string;
  explorer: string;
  /** Circle USDC on this chain (FiatTokenV2_2: EIP-3009 + EIP-2612). Empty on anvil. */
  usdc: string;
  mainnet: boolean;
  faucets: { what: string; url: string }[];
}

export const ENTRYPOINT_V08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

export const CHAINS: Record<string, ChainInfo> = {
  'base-sepolia': {
    key: 'base-sepolia',
    chainId: 84532,
    name: 'Base Sepolia',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    mainnet: false,
    faucets: [
      { what: 'Base Sepolia ETH (gas)', url: 'https://www.alchemy.com/faucets/base-sepolia' },
      { what: 'Base Sepolia ETH (gas), alternative', url: 'https://docs.base.org/chain/network-faucets' },
      { what: 'test USDC (10 USDC per request, choose Base Sepolia)', url: 'https://faucet.circle.com' },
    ],
  },
  anvil: {
    key: 'anvil',
    chainId: 31337,
    name: 'Local anvil (rehearsal only)',
    rpc: 'http://127.0.0.1:8545',
    explorer: '',
    usdc: '',
    mainnet: false,
    faucets: [],
  },
  base: {
    key: 'base',
    chainId: 8453,
    name: 'Base mainnet',
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    mainnet: true,
    faucets: [],
  },
};

export function chainByKey(key: string): ChainInfo {
  const c = CHAINS[key];
  if (!c) throw new Error(`unknown chain "${key}" (known: ${Object.keys(CHAINS).join(', ')})`);
  return c;
}

export const MAINNET_IDS = new Set([1, 10, 137, 8453, 42161]);

export const txUrl = (explorer: string, hash: string): string => (explorer ? `${explorer}/tx/${hash}` : hash);
export const addrUrl = (explorer: string, a: string): string => (explorer ? `${explorer}/address/${a}` : a);
