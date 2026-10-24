/**
 * `live.ts status` and the console's /api/status: everything the demo needs on one screen, read from
 * the chain and the three real services. All amounts are decimal strings in base units (USDC 6 dec,
 * ETH wei); `render` prints them for humans with explorer links.
 */
import { type Address, formatEther, formatUnits } from 'viem';
import { accountAbi, loadArtifact } from '../../lib/stack.ts';
import { addrUrl } from './chains.ts';
import { fetchJson, loadState, publicClient, usdcAbi } from './chainio.ts';
import type { Live } from './envfile.ts';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface BucketView {
  burst: string;
  ratePerDay: string;
  available: string;
  configured: boolean;
}
export interface Status {
  chain: { id: number; name: string; block: string; time: number };
  account: { address: string; deployed: boolean; owner: string; ownerOk: boolean };
  balances: { usdc: string; eth: string; deposit: string; merchantUsdc: string; deployerEth: string; watcherEth: string; attestorEth: string };
  agent: { address: string; live: boolean; revoked: boolean; validUntil: number; frozen: boolean; strikes: string };
  limits: { global: BucketView; key: BucketView; explore: BucketView; perTxCap: string; explorePerTxCap: string; dailyLimit: string };
  onchain: { attestor: string; watcher: string; guardians: number; threshold: number; freeze: { velocityBps: string; sprayMax: string; strikeMax: string }; recovery: { proposalId: string; newOwner: string; proposedAt: number; approvals: string; vetoed: boolean } | null };
  attacker: { address: string; usdc: string; sprayUsdc: string; total: string; sprayAddresses: number };
  services: { attestor: string; approval: string; watcher: string };
  recent: { at: string; attack: string; summary: string }[];
}

const bucket = (b: { burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: number }, now: number): BucketView => {
  const configured = b.lastRefill !== 0;
  let level = b.level;
  if (now > b.lastRefill) level += (b.ratePerDay * BigInt(now - b.lastRefill)) / 86_400n;
  if (level > b.burst) level = b.burst;
  return { burst: b.burst.toString(), ratePerDay: b.ratePerDay.toString(), available: configured ? level.toString() : '0', configured };
};

async function health(url: string): Promise<string> {
  try {
    const r = await fetchJson<{ ok?: boolean; status?: string }>(`${url}/health`, undefined, 2500);
    return r.ok ? 'up' : `http ${r.status}`;
  } catch {
    return 'down';
  }
}

export async function getStatus(L: Live): Promise<Status> {
  const pub = publicClient(L);
  const abi = accountAbi();
  const ep = loadArtifact('EntryPoint').abi;
  const block = await pub.getBlock();
  const now = Number(block.timestamp);
  const account = (L.account || ZERO) as Address;
  const deployed = account !== ZERO && ((await pub.getCode({ address: account })) ?? '0x') !== '0x';
  const rd = <T>(fn: string, args: unknown[] = []) => pub.readContract({ address: account, abi, functionName: fn, args } as never) as Promise<T>;
  const bal = (a: Address) => pub.readContract({ address: L.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
  const eth = (a: Address) => pub.getBalance({ address: a });
  const st = loadState();

  const out: Status = {
    chain: { id: L.chainId, name: L.chainName, block: block.number.toString(), time: now },
    account: { address: account, deployed, owner: '', ownerOk: false },
    balances: { usdc: '0', eth: '0', deposit: '0', merchantUsdc: (await bal(L.merchant)).toString(), deployerEth: (await eth(L.addr.deployer)).toString(), watcherEth: (await eth(L.addr.watcher)).toString(), attestorEth: (await eth(L.addr.attestor)).toString() },
    agent: { address: L.addr.agent, live: false, revoked: false, validUntil: 0, frozen: false, strikes: '0' },
    limits: { global: { burst: '0', ratePerDay: '0', available: '0', configured: false }, key: { burst: '0', ratePerDay: '0', available: '0', configured: false }, explore: { burst: '0', ratePerDay: '0', available: '0', configured: false }, perTxCap: '0', explorePerTxCap: '0', dailyLimit: '0' },
    onchain: { attestor: ZERO, watcher: ZERO, guardians: 0, threshold: 0, freeze: { velocityBps: '0', sprayMax: '0', strikeMax: '0' }, recovery: null },
    attacker: { address: L.addr.attacker, usdc: '0', sprayUsdc: '0', total: '0', sprayAddresses: st.spray.length },
    services: { attestor: await health(L.urls.attestor), approval: await health(L.urls.approval), watcher: await health(L.urls.watcher) },
    recent: st.attackLog.slice(-6),
  };
  const attackerUsdc = await bal(L.addr.attacker);
  let spray = 0n;
  for (const a of st.spray) spray += await bal(a);
  out.attacker = { address: L.addr.attacker, usdc: attackerUsdc.toString(), sprayUsdc: spray.toString(), total: (attackerUsdc + spray).toString(), sprayAddresses: st.spray.length };
  if (!deployed) return out;

  const owner = await rd<Address>('owner');
  out.account.owner = owner;
  out.account.ownerOk = !!L.owner && owner.toLowerCase() === L.owner.toLowerCase();
  out.balances.usdc = (await bal(account)).toString();
  out.balances.eth = (await eth(account)).toString();
  out.balances.deposit = ((await pub.readContract({ address: L.entryPoint, abi: ep, functionName: 'balanceOf', args: [account] })) as bigint).toString();

  const [sid, session] = await rd<[bigint, { revoked: boolean; validAfter: number; validUntil: number }]>('sessionOf', [L.addr.agent]);
  out.agent.live = sid !== 0n && !session.revoked && now <= Number(session.validUntil);
  out.agent.revoked = sid !== 0n && session.revoked;
  out.agent.validUntil = Number(session.validUntil);
  out.agent.frozen = await rd<boolean>('isFrozen', [L.addr.agent]);
  out.agent.strikes = (await rd<bigint>('strikes', [L.addr.agent])).toString();

  const g = await rd<{ burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: number }>('globalBucket', [L.usdc]);
  const k = await rd<{ enabled: boolean; perTxCap: bigint; bucket: { burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: number } }>('keyAsset', [L.addr.agent, L.usdc]);
  const x = await rd<{ burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: number }>('exploreBucket', [L.usdc]);
  out.limits = {
    global: bucket(g, now),
    key: bucket(k.bucket, now),
    explore: bucket(x, now),
    perTxCap: k.perTxCap.toString(),
    explorePerTxCap: (await rd<bigint>('explorePerTxCap', [L.usdc])).toString(),
    dailyLimit: (g.burst + g.ratePerDay).toString(),
  };

  const [guardians, threshold] = await rd<[Address[], number]>('guardians');
  const param = async (n: string) => {
    const { keccak256, toBytes } = await import('viem');
    return (await rd<bigint>('freezeParam', [keccak256(toBytes(`hypnexis.freeze.${n}`))])).toString();
  };
  const pending = await rd<[bigint, Address, number, bigint, boolean]>('pendingRecovery');
  out.onchain = {
    attestor: await rd<Address>('attestor'),
    watcher: await rd<Address>('watcher'),
    guardians: guardians.length,
    threshold: Number(threshold),
    freeze: { velocityBps: await param('velocityBps'), sprayMax: await param('sprayMax'), strikeMax: await param('strikeMax') },
    recovery: pending[1] !== ZERO ? { proposalId: pending[0].toString(), newOwner: pending[1], proposedAt: Number(pending[2]), approvals: pending[3].toString(), vetoed: pending[4] } : null,
  };
  return out;
}

const usd = (x: string, d = 6) => `${Number(formatUnits(BigInt(x), d)).toFixed(2)} USDC`;
const eth = (x: string) => `${Number(formatEther(BigInt(x))).toFixed(5)} ETH`;

export function render(s: Status, L: Live): string {
  const link = (a: string) => (L.explorer ? ` ${addrUrl(L.explorer, a)}` : '');
  const lines: string[] = [];
  lines.push(`${s.chain.name} (chain ${s.chain.id}), block ${s.chain.block}`);
  lines.push(`ACCOUNT   ${s.account.address}${link(s.account.address)}`);
  if (!s.account.deployed) {
    lines.push('          not deployed yet: the owner creates it in the console (button 1)');
  } else {
    lines.push(`  owner     ${s.account.owner} ${s.account.ownerOk ? '(matches OWNER_ADDRESS)' : '(DOES NOT MATCH OWNER_ADDRESS)'}`);
    lines.push(`  holds     ${usd(s.balances.usdc)}   gas deposit ${eth(s.balances.deposit)}`);
    lines.push(`  daily limit ${usd(s.limits.dailyLimit)}: global bucket ${usd(s.limits.global.available)} available now; per-payment cap ${usd(s.limits.perTxCap)}`);
    lines.push(`  unknown-payee budget ${usd(s.limits.explore.available)} left, ${usd(s.limits.explorePerTxCap)} per payment`);
    lines.push(`  freeze tripwires: velocity ${s.onchain.freeze.velocityBps} bps, spray ${s.onchain.freeze.sprayMax}, strikes ${s.onchain.freeze.strikeMax}; watcher on-chain ${s.onchain.watcher}; attestor on-chain ${s.onchain.attestor}`);
    if (s.onchain.recovery) lines.push(`  RECOVERY PENDING #${s.onchain.recovery.proposalId} -> ${s.onchain.recovery.newOwner} (approvals bitmap ${s.onchain.recovery.approvals})`);
  }
  lines.push(`AGENT KEY ${s.agent.address}: ${s.agent.live ? 'live' : s.agent.revoked ? 'REVOKED' : 'no session'}${s.agent.frozen ? ', FROZEN' : ''}, strikes ${s.agent.strikes}`);
  lines.push(`ATTACKER  ${s.attacker.address}${link(s.attacker.address)}: holds ${usd(s.attacker.total)} (${usd(s.attacker.usdc)} + ${s.attacker.sprayAddresses} spray addresses ${usd(s.attacker.sprayUsdc)})`);
  lines.push(`MERCHANT  ${L.merchant}: ${usd(s.balances.merchantUsdc)}`);
  lines.push(`SERVICES  attestor ${s.services.attestor}, approval ${s.services.approval}, watcher ${s.services.watcher}`);
  lines.push(`GAS       deployer/relayer ${eth(s.balances.deployerEth)}, watcher ${eth(s.balances.watcherEth)}, attestor ${eth(s.balances.attestorEth)}`);
  return lines.join('\n');
}
