import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createWalletClient, custom, getAddress, numberToHex, type Abi, type Address, type Hex } from 'viem';
import { chain, publicClient } from './client';
import type { TypedData } from '@/api/schemas';

type WalletState = {
  hasProvider: boolean;
  account: Address | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  signTypedData: (data: TypedData) => Promise<Hex>;
  /** personal_sign (EIP-191) of a short text, used to decline an approval request. */
  signMessage: (message: string) => Promise<Hex>;
  write: (args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) => Promise<Hex>;
  /** Open this page inside MetaMask Mobile's browser, where signing works without extra setup. */
  metamaskDeepLink: string;
};

const Ctx = createContext<WalletState | null>(null);

function friendly(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string };
  if (err?.code === 4001) return 'You declined the request in your wallet.';
  if (err?.code === -32002) return 'Your wallet already has a request open. Check MetaMask.';
  return err?.shortMessage ?? err?.message ?? 'The wallet returned an error.';
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    provider
      .request({ method: 'eth_accounts' })
      .then((a) => {
        const list = a as string[];
        if (list[0]) setAccount(getAddress(list[0]));
      })
      .catch(() => {});
    provider
      .request({ method: 'eth_chainId' })
      .then((c) => setChainId(Number(c as string)))
      .catch(() => {});
    const onAccounts = (a: unknown) => {
      const list = a as string[];
      setAccount(list[0] ? getAddress(list[0]) : null);
    };
    const onChain = (c: unknown) => setChainId(Number(c as string));
    provider.on?.('accountsChanged', onAccounts);
    provider.on?.('chainChanged', onChain);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, [provider]);

  const connect = useCallback(async () => {
    if (!provider) return;
    setConnecting(true);
    setError(null);
    try {
      const a = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      if (a[0]) setAccount(getAddress(a[0]));
      setChainId(Number((await provider.request({ method: 'eth_chainId' })) as string));
    } catch (e) {
      setError(friendly(e));
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  const switchChain = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chain.id) }] });
    } catch (e) {
      const err = e as { code?: number };
      if (err.code === 4902) {
        try {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: numberToHex(chain.id),
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: chain.rpcUrls.default.http,
                blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
              },
            ],
          });
        } catch (e2) {
          setError(friendly(e2));
        }
      } else setError(friendly(e));
    }
  }, [provider]);

  const signTypedData = useCallback(
    async (data: TypedData): Promise<Hex> => {
      if (!provider || !account) throw new Error('Connect your wallet first.');
      const domainType = [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ];
      const payload = {
        domain: data.domain,
        types: { EIP712Domain: domainType, ...data.types },
        primaryType: data.primaryType,
        message: data.message,
      };
      try {
        return (await provider.request({
          method: 'eth_signTypedData_v4',
          params: [account, JSON.stringify(payload)],
        })) as Hex;
      } catch (e) {
        throw new Error(friendly(e));
      }
    },
    [provider, account],
  );

  const signMessage = useCallback(
    async (message: string): Promise<Hex> => {
      if (!provider || !account) throw new Error('Connect your wallet first.');
      try {
        const client = createWalletClient({ account, chain, transport: custom(provider) });
        return await client.signMessage({ account, message });
      } catch (e) {
        throw new Error(friendly(e));
      }
    },
    [provider, account],
  );

  const write = useCallback<WalletState['write']>(
    async ({ address, abi, functionName, args }) => {
      if (!provider || !account) throw new Error('Connect your wallet first.');
      const client = createWalletClient({ account, chain, transport: custom(provider) });
      try {
        const { request } = await publicClient.simulateContract({ account, address, abi, functionName, args });
        return await client.writeContract(request);
      } catch (e) {
        throw new Error(friendly(e));
      }
    },
    [provider, account],
  );

  const value = useMemo<WalletState>(
    () => ({
      hasProvider: Boolean(provider),
      account,
      chainId,
      connecting,
      error,
      connect,
      switchChain,
      signTypedData,
      signMessage,
      write,
      metamaskDeepLink:
        typeof window !== 'undefined'
          ? `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}${window.location.search}`
          : '',
    }),
    [provider, account, chainId, connecting, error, connect, switchChain, signTypedData, signMessage, write],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}

export async function waitForReceipt(hash: Hex) {
  return publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
}
