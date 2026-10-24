/**
 * Scripted owner signer CLI [A18] (anvil dev keys anywhere, other keys on testnets only).
 *   pnpm --filter @hypnexis/approval sign -- --id <requestId> [--url http://127.0.0.1:8788]
 *        [--reject] [--wait] [--max <baseUnits>] [--account 0x..] [--chain-id 31337]
 * Key: OWNER_PRIVATE_KEY env, or --dev-key <0-9> (anvil default mnemonic). Prints what a wallet would
 * show, then one JSON line with the service answer. Exit 0 iff the service accepted.
 */
import type { Address, Hex } from 'viem';
import { ANVIL_DEV_KEYS, KeyPolicyError, ownerSign } from '../src/ownerSigner.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const id = arg('id');
  if (!id) {
    console.error('usage: owner-sign --id <requestId> [--url URL] [--reject] [--wait] [--max N] [--account 0x..] [--chain-id N] [--dev-key 0-9]');
    return 2;
  }
  const devIdx = arg('dev-key');
  const key = (devIdx !== undefined ? ANVIL_DEV_KEYS[Number(devIdx)] : process.env.OWNER_PRIVATE_KEY) as Hex | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('owner key missing: set OWNER_PRIVATE_KEY or pass --dev-key <0-9>');
    return 2;
  }
  try {
    const r = await ownerSign({
      baseUrl: arg('url') ?? process.env.APPROVAL_URL ?? 'http://127.0.0.1:8788',
      id,
      key,
      reject: flag('reject'),
      wait: flag('wait'),
      maxAmount: arg('max') !== undefined ? BigInt(arg('max')!) : undefined,
      expect: { account: arg('account') as Address | undefined, chainId: arg('chain-id') !== undefined ? Number(arg('chain-id')) : undefined },
    });
    console.error(r.display);
    console.error(`signed by ${r.signer}`);
    console.log(JSON.stringify({ http: r.http, ...r.body }));
    return r.http >= 200 && r.http < 300 ? 0 : 1;
  } catch (e) {
    console.error(e instanceof KeyPolicyError ? `refused: ${e.message}` : `failed: ${(e as Error).message}`);
    return 1;
  }
}

main().then((c) => process.exit(c));
