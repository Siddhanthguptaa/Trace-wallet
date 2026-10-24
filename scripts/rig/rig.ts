/**
 * Projector rig stub (FASTPLAN cut: one minimal script, no dry-run gate). Three commands for a live
 * demo on a TESTNET (Base Sepolia 84532, Sepolia 11155111) or a local anvil (31337); it refuses any
 * other chain, so it can never touch mainnet funds.
 *
 *   rig.ts new-key                         a fresh throwaway agent key + address (printed, never saved)
 *   rig.ts fund --to 0x.. --eth 0.01       send test ETH from FUNDER_KEY to an address
 *   rig.ts reset --account 0x.. --agents 0x..,0x..   owner: revoke the listed agent keys, unfreeze them,
 *                                          bump the attestation epoch (old attestations die), so the
 *                                          next take starts from a clean wallet with a new key
 * Env: RPC_URL, FUNDER_KEY (fund), OWNER_KEY (reset; a test owner key, never a real one).
 */
import { type Address, type Hex, createPublicClient, createWalletClient, getAddress, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { accountAbi, chainOf } from '../lib/stack.ts';

const TESTNETS = new Set([31337, 84532, 11155111]);
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function clients() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL is required');
  const chainId = Number(BigInt(((await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })).json()) as { result: string }).result));
  if (!TESTNETS.has(chainId)) throw new Error(`chain ${chainId} is not a testnet: the rig refuses (allowed: ${[...TESTNETS].join(', ')})`);
  const chain = chainOf({ rpcUrl, chainId });
  return { pub: createPublicClient({ chain, transport: http(rpcUrl) }), wallet: (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpcUrl) }), chainId };
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'new-key') {
    const k = generatePrivateKey();
    console.log(JSON.stringify({ address: privateKeyToAccount(k).address, privateKey: k, note: 'throwaway: for this demo run only' }, null, 2));
    return;
  }
  const c = await clients();
  if (cmd === 'fund') {
    const key = process.env.FUNDER_KEY as Hex | undefined;
    if (!key) throw new Error('FUNDER_KEY is required');
    const to = getAddress(arg('--to') ?? (() => { throw new Error('--to required'); })());
    const w = c.wallet(key);
    const hash = await w.sendTransaction({ to, value: parseEther(arg('--eth') ?? '0.01') });
    await c.pub.waitForTransactionReceipt({ hash });
    console.log(`funded ${to} on chain ${c.chainId}: ${hash}`);
    return;
  }
  if (cmd === 'reset') {
    const key = process.env.OWNER_KEY as Hex | undefined;
    if (!key) throw new Error('OWNER_KEY is required (a test owner key)');
    const account = getAddress(arg('--account') ?? (() => { throw new Error('--account required'); })());
    const agents = (arg('--agents') ?? '').split(',').filter(Boolean).map((a) => getAddress(a));
    const A = accountAbi();
    const w = c.wallet(key);
    const send = async (fn: string, args: unknown[]) => c.pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: account, abi: A, functionName: fn, args, gas: 3_000_000n } as never) });
    for (const a of agents) {
      await send('revoke', [a]);
      const frozen = (await c.pub.readContract({ address: account, abi: A, functionName: 'isFrozen', args: [a] } as never)) as boolean;
      if (frozen) await send('unfreeze', [a]);
    }
    await send('bumpEpoch', []);
    console.log(`reset ${account}: revoked ${agents.length} agent key(s), cleared freezes, bumped the attestation epoch`);
    return;
  }
  console.log('usage: rig.ts new-key | fund --to 0x.. [--eth 0.01] | reset --account 0x.. --agents 0x..,0x..');
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
void (null as unknown as Address);
