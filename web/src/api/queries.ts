import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { agentTools, approvals, attestor, runner } from './clients';
import { fetchActivity } from '@/chain/activity';
import { publicClient } from '@/chain/client';
import { erc20Abi } from '@/chain/abi';

const CHAIN_POLL = 4_000;

export const qk = {
  policy: (w: string) => ['policy', w] as const,
  budget: (w: string) => ['budget', w] as const,
  approvals: (w: string, s?: string) => ['approvals', w, s ?? 'all'] as const,
  approval: (id: string) => ['approval', id] as const,
  attest: (w: string, p: string) => ['attest', w, p] as const,
  activity: (w: string) => ['activity', w] as const,
  balance: (a: string, w: string) => ['balance', a, w] as const,
};

export function usePolicy(wallet: Address | undefined) {
  return useQuery({
    queryKey: qk.policy(wallet ?? ''),
    queryFn: () => agentTools.getPolicy(wallet!),
    enabled: Boolean(wallet),
    refetchInterval: 15_000,
  });
}

export function useBudget(wallet: Address | undefined) {
  return useQuery({
    queryKey: qk.budget(wallet ?? ''),
    queryFn: () => agentTools.getBudget(wallet!),
    enabled: Boolean(wallet),
    refetchInterval: CHAIN_POLL,
  });
}

export function useApprovals(wallet: Address | undefined, status?: string) {
  return useQuery({
    queryKey: qk.approvals(wallet ?? '', status),
    queryFn: () => approvals.list(wallet!, status),
    enabled: Boolean(wallet),
    refetchInterval: 6_000,
  });
}

export function useApproval(id: string | undefined) {
  return useQuery({
    queryKey: qk.approval(id ?? ''),
    queryFn: () => approvals.get(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'signed' || s === 'relayed' ? 2_000 : 10_000;
    },
  });
}

export function useAttestation(wallet: Address | undefined, payee: Address | undefined) {
  return useQuery({
    queryKey: qk.attest(wallet ?? '', payee ?? ''),
    queryFn: () => attestor.attest(wallet!, payee!),
    enabled: Boolean(wallet && payee),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useActivity(wallet: Address | undefined) {
  return useQuery({
    queryKey: qk.activity(wallet ?? ''),
    queryFn: () => fetchActivity(wallet!),
    enabled: Boolean(wallet),
    refetchInterval: 20_000,
  });
}

export function useTokenBalance(asset: Address | undefined, wallet: Address | undefined) {
  return useQuery({
    queryKey: qk.balance(asset ?? '', wallet ?? ''),
    queryFn: () => publicClient.readContract({ address: asset!, abi: erc20Abi, functionName: 'balanceOf', args: [wallet!] }),
    enabled: Boolean(asset && wallet),
    refetchInterval: CHAIN_POLL,
  });
}

export const useCards = () => useQuery({ queryKey: ['cards'], queryFn: runner.cards, staleTime: 300_000 });
export const useConfigs = () => useQuery({ queryKey: ['configs'], queryFn: runner.configs, staleTime: 300_000 });
export const useBounty = () => useQuery({ queryKey: ['bounty'], queryFn: runner.bounty, staleTime: 300_000 });
export const useResults = () => useQuery({ queryKey: ['results'], queryFn: runner.results, refetchInterval: 30_000 });
