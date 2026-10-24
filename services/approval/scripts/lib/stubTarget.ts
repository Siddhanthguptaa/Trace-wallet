/**
 * E2E target interface + the default stub target: EntryPoint v0.8 (contracts/lib/account-abstraction)
 * and test/anvil/ApprovalStub.sol (approval path verified with CORE's TypedData.sol). INT supplies a
 * module whose default export is an E2ETarget for the real AgentAccount (E2E_TARGET_MODULE).
 */
import { type Abi, type Address, type Hex, encodeFunctionData, getAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type Artifact, type DevChain, ENTRYPOINT_SOURCE, STUB_SOURCE, clients, compile, deploy, send } from './devchain.ts';

export interface E2EKeys {
  owner: Hex;
  agent: Hex;
  shop: Hex;
}

export interface E2EWorld {
  account: Address;
  entryPoint: Address;
  /** 6-decimal token the account holds and tracks. */
  token: Address;
  /** pulls price * qty of `token` through the account's allowance: order(uint256 qty). */
  shop: Address;
  /** shop.price() at setup. */
  price: bigint;
  /** an address with a PAYEE rule path: token.transfer(payee, amount) needs owner approval. */
  payee: Address;
  setPrice(p: bigint): Promise<void>;
}

export interface E2ETarget {
  name: string;
  realAccount: boolean;
  setup(chain: DevChain, keys: E2EKeys): Promise<E2EWorld>;
}

export const shopAbi = parseAbi(['function order(uint256 qty)', 'function setPrice(uint256 p)', 'function price() view returns (uint256)']);
export const tokenAbi = parseAbi([
  'function mint(address to, uint256 v)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function transfer(address, uint256) returns (bool)',
]);

export interface StubArtifacts {
  entryPoint: Artifact;
  account: Artifact;
  token: Artifact;
  shop: Artifact;
}

export function compileStubWorld(solc: string): StubArtifacts {
  const a = compile(solc, [STUB_SOURCE, ENTRYPOINT_SOURCE]);
  const pick = (n: string) => {
    const x = a[n];
    if (!x) throw new Error(`${n} missing from solc output`);
    return x;
  };
  return { entryPoint: pick('EntryPoint'), account: pick('ApprovalAccountStub'), token: pick('StubToken'), shop: pick('StubShop') };
}

export const PAYEE: Address = getAddress('0x00000000000000000000000000000000C0FFEE01');

export function stubTarget(art: StubArtifacts): E2ETarget {
  return {
    name: 'ApprovalAccountStub (services/approval/test/anvil, digest from contracts/src/lib/TypedData.sol) + EntryPoint v0.8',
    realAccount: false,
    async setup(chain, keys) {
      const owner = privateKeyToAccount(keys.owner).address;
      const agent = privateKeyToAccount(keys.agent).address;
      const { pub } = clients(chain, keys.owner);
      const now = Number((await pub.getBlock()).timestamp);
      const entryPoint = await deploy(chain, art.entryPoint, [], keys.owner);
      const token = await deploy(chain, art.token, [], keys.owner);
      const price = 3_000_000n;
      const shop = await deploy(chain, art.shop, [token, price], keys.shop);
      const account = await deploy(chain, art.account, [entryPoint, owner, agent, [token], [shop], now + 6 * 86400], keys.owner);
      const acc = { address: account, abi: art.account.abi as Abi };
      await send(chain, keys.owner, { address: token, abi: tokenAbi, functionName: 'mint', args: [account, 50_000_000n] });
      const { wallet } = clients(chain, keys.owner);
      await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: account, value: 10n ** 18n, account: wallet.account, chain: wallet.chain }) });
      // owner setup: the shop's allowance (approve-then-pull) and a PAYEE rule on token.transfer arg 0
      await send(chain, keys.owner, { ...acc, functionName: 'execute', args: [token, 0n, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [shop, 20_000_000n] })] });
      await send(chain, keys.owner, { ...acc, functionName: 'setPayeeRule', args: [token, '0xa9059cbb', 0] });
      return {
        account,
        entryPoint,
        token,
        shop,
        price,
        payee: PAYEE,
        async setPrice(p: bigint) {
          await send(chain, keys.shop, { address: shop, abi: shopAbi, functionName: 'setPrice', args: [p] });
        },
      };
    },
  };
}
