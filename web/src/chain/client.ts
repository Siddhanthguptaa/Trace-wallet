import { createPublicClient, defineChain, http, type Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { config } from '@/config';

function pickChain(id: number): Chain {
  if (id === base.id) return base;
  if (id === baseSepolia.id) return baseSepolia;
  return defineChain({
    id,
    name: id === 31337 ? 'Local fork' : `Chain ${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl ?? 'http://127.0.0.1:8545'] } },
  });
}

export const chain = pickChain(config.chainId);
export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
