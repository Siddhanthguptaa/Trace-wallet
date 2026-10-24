/**
 * The OWNER transactions that configure R3 and R4, as plain data. Two uses:
 *   1. `live.ts owner-pack` prints / writes them (scripts/live/owner_txs.json) so you can send each one from
 *      MetaMask if you prefer that to the frontend's Setup / Policy / Keys screens.
 *   2. rehearse.ts replays the SAME transactions through an anvil-impersonated owner.
 * No key is involved: these are calldata for the owner to sign.
 */
import { type Address, type Hex, encodeFunctionData } from 'viem';
import { accountOwnerAbi } from './abi.ts';
import { type TxSpec, actionById } from './ownerActions.ts';
import { type Live, publicConfig } from './envfile.ts';

export interface PackStep extends TxSpec {
  title: string;
}
export interface Pack {
  wallet: 'R3' | 'R4';
  account: Address;
  steps: PackStep[];
}

const enc = (fn: string, args: unknown[]): Hex => encodeFunctionData({ abi: accountOwnerAbi, functionName: fn, args } as never);

export function ownerPack(L: Live, now: number): Pack[] {
  const out: Pack[] = [];
  for (const wallet of ['R3', 'R4'] as const) {
    const account = L.wallets[wallet];
    if (!account) throw new Error(`${wallet} is not deployed: run live.ts deploy`);
    const c = publicConfig(L, account);
    const steps: PackStep[] = [];
    const add = (title: string, txs: TxSpec[]) => txs.forEach((t) => steps.push({ ...t, title }));
    add('daily limit', actionById('setGlobalCap').txs(c, { now }));
    if (wallet === 'R3') {
      // R3 = ours WITHOUT D3: no exploration budget, so every unknown payee needs the owner
      add('no exploration budget (R3)', [
        { to: account, data: enc('setExploreCap', [L.usdc, 0n, 0n]), value: 0n, label: 'setExploreCap(USDC, 0, 0)' },
        { to: account, data: enc('setExplorePerTxCap', [L.usdc, 0n]), value: 0n, label: 'setExplorePerTxCap(USDC, 0)' },
      ]);
    }
    add('trust one merchant', actionById('listMerchant').txs(c, { now }));
    add('watch allowances to the merchant', actionById('setTrackedSpenders').txs(c, { now }));
    add('session key for the agent', actionById('setPolicy').txs(c, { now }));
    if (wallet === 'R4') add('accept the real attestor (R4)', actionById('setAttestor').txs(c, { now }));
    add('let the watcher freeze', actionById('setWatcher').txs(c, { now }));
    add('five guardians, 3 of 5', actionById('setGuardians').txs(c, { now }));
    add('freeze tripwires', actionById('setFreezeThresholds').txs(c, { now }));
    out.push({ wallet, account, steps });
  }
  return out;
}
