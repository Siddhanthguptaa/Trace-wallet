import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Abi, type AbiEvent, type Address, type Hex, type Log, encodeAbiParameters, encodeEventTopics, getAddress, pad } from 'viem';
import {
  ACCOUNT_EVENTS_ABI,
  type AccountReader,
  ENTRYPOINT_EVENTS_ABI,
  type FreezeWriter,
  agentKeyFromNonce,
  decodeLogs,
} from '../src/chain.ts';
import { FreezeSender } from '../src/freezer.ts';
import { WatcherService } from '../src/service.ts';

const ACC = getAddress('0x00000000000000000000000000000000000000a1');
const ACC2 = getAddress('0x00000000000000000000000000000000000000a2');
const EP = getAddress('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108');
const WATCHER = getAddress('0x00000000000000000000000000000000000000ee');
const KEY = getAddress('0x1111111111111111111111111111111111111111');
const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const T0 = 1_800_000_000;
const H = pad('0x01', { size: 32 });

function stubs(opts: { watcher?: Address; frozen?: boolean; fail?: number } = {}) {
  const calls: Array<[Address, Address]> = [];
  let fail = opts.fail ?? 0;
  const frozen = new Set<string>(opts.frozen ? [`${ACC.toLowerCase()}:${KEY.toLowerCase()}`] : []);
  const writer: FreezeWriter = {
    async freeze(account, agentKey) {
      if (fail > 0) {
        fail--;
        throw new Error('rpc down\nstack');
      }
      calls.push([account, agentKey]);
      frozen.add(`${account.toLowerCase()}:${agentKey.toLowerCase()}`);
      return `0x${'ab'.repeat(32)}` as Hex;
    },
  };
  const reader: AccountReader = {
    isFrozen: async (a, k) => frozen.has(`${a.toLowerCase()}:${k.toLowerCase()}`),
    watcher: async () => opts.watcher ?? WATCHER,
    globalCap: async () => 20_000_000n,
  };
  return { writer, reader, calls };
}

/** Encode an event log (this viem version has no encodeEventLog). */
function encodeEventLog(p: { abi: Abi; eventName: string; args: Record<string, unknown> }): { data: Hex; topics: Hex[] } {
  const ev = p.abi.find((x) => x.type === 'event' && x.name === p.eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName: p.eventName, args: p.args } as never) as Hex[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => p.args[i.name!]) as never);
  return { data, topics };
}

function log(address: Address, data: Hex, topics: Hex[], blockNumber: bigint, logIndex: number): Log {
  return { address, data, topics: topics as [Hex, ...Hex[]], blockNumber, logIndex } as unknown as Log;
}

describe('FreezeSender', () => {
  it('sends once, dedupes concurrent alarms, then reports already', async () => {
    const s = stubs();
    const f = new FreezeSender({ writer: s.writer, reader: s.reader, watcher: WATCHER });
    const [a, b] = await Promise.all([f.ensureFrozen(ACC, KEY, 'x'), f.ensureFrozen(ACC, KEY, 'y')]);
    assert.equal(a.status, 'sent');
    assert.equal(b.status, 'sent', 'the second caller shares the in-flight send');
    assert.equal(s.calls.length, 1);
    assert.equal((await f.ensureFrozen(ACC, KEY, 'z')).status, 'already');
  });

  it('skips accounts whose watcher is someone else, and keys already frozen on-chain', async () => {
    const other = stubs({ watcher: getAddress('0x00000000000000000000000000000000000000ff') });
    const f1 = new FreezeSender({ writer: other.writer, reader: other.reader, watcher: WATCHER });
    const r1 = await f1.ensureFrozen(ACC, KEY, 'x');
    assert.equal(r1.status, 'skipped');
    assert.equal(other.calls.length, 0);
    const fr = stubs({ frozen: true });
    const f2 = new FreezeSender({ writer: fr.writer, reader: fr.reader, watcher: WATCHER });
    assert.equal((await f2.ensureFrozen(ACC, KEY, 'x')).status, 'already');
    assert.equal(fr.calls.length, 0);
    const f3 = new FreezeSender({ writer: null, reader: null, watcher: WATCHER });
    assert.equal((await f3.ensureFrozen(ACC, KEY, 'x')).status, 'skipped');
  });

  it('reports RPC errors with the first line only', async () => {
    const s = stubs({ fail: 1 });
    const f = new FreezeSender({ writer: s.writer, reader: s.reader, watcher: WATCHER });
    const r = await f.ensureFrozen(ACC, KEY, 'x');
    assert.deepEqual(r.status === 'error' && r.reason, 'rpc down');
  });

  it('has no unfreeze path (escalate-only by construction)', () => {
    const f = new FreezeSender({ writer: null, reader: null, watcher: WATCHER }) as unknown as Record<string, unknown>;
    assert.equal(f.unfreeze, undefined);
  });
});

describe('decodeLogs', () => {
  it('agent key from the nonce; owner ops (key 0) map to null', () => {
    const nonceKey = (BigInt(KEY) << 32n) | (5n << 8n) | 1n;
    assert.equal(agentKeyFromNonce((nonceKey << 64n) | 9n), KEY);
    assert.equal(agentKeyFromNonce(7n), null);
  });

  it('Decision -> ok + spend (not on Track.APPROVAL); PolicyBlocked / failed UserOp -> failure; freeze events', () => {
    const decision = (track: number) =>
      encodeEventLog({
        abi: ACCOUNT_EVENTS_ABI,
        eventName: 'Decision',
        args: {
          userOpHash: H,
          agentKey: KEY,
          target: USDC,
          selector: '0xa9059cbb',
          payee: ACC2,
          tier: 1,
          track,
          outflows: [
            { asset: USDC, amount: 5_000_000n },
            { asset: USDC, amount: 0n },
          ],
        },
      });
    const blocked = encodeEventLog({
      abi: ACCOUNT_EVENTS_ABI,
      eventName: 'PolicyBlocked',
      args: { userOpHash: H, agentKey: KEY, target: USDC, selector: '0xa9059cbb', reason: '0x2ea3ad1b0000' },
    });
    const frozen = encodeEventLog({ abi: ACCOUNT_EVENTS_ABI, eventName: 'AgentFrozen', args: { agentKey: KEY, by: ACC, userOpHash: H } });
    const unfrozen = encodeEventLog({ abi: ACCOUNT_EVENTS_ABI, eventName: 'AgentUnfrozen', args: { agentKey: KEY } });
    const nonce = ((BigInt(KEY) << 32n) << 64n) | 3n;
    const uoe = (success: boolean, sender: Address, n: bigint) =>
      encodeEventLog({
        abi: ENTRYPOINT_EVENTS_ABI,
        eventName: 'UserOperationEvent',
        args: { userOpHash: H, sender, paymaster: '0x0000000000000000000000000000000000000000', nonce: n, success, actualGasCost: 1n, actualGasUsed: 1n },
      });
    const logs = [
      log(ACC, decision(0).data, decision(0).topics, 1n, 0),
      log(ACC, decision(2).data, decision(2).topics, 1n, 1),
      log(ACC, blocked.data, blocked.topics, 2n, 0),
      log(EP, uoe(false, ACC, nonce).data, uoe(false, ACC, nonce).topics, 2n, 1),
      log(EP, uoe(true, ACC, nonce).data, uoe(true, ACC, nonce).topics, 2n, 2), // success: no event
      log(EP, uoe(false, ACC, 1n).data, uoe(false, ACC, 1n).topics, 2n, 3), // owner op: skipped
      log(EP, uoe(false, ACC2, nonce).data, uoe(false, ACC2, nonce).topics, 2n, 4), // not watched
      log(ACC2, blocked.data, blocked.topics, 2n, 5), // not watched
      log(ACC, frozen.data, frozen.topics, 3n, 0),
      log(ACC, unfrozen.data, unfrozen.topics, 3n, 1),
      log(ACC, encodeAbiParameters([{ type: 'uint256' }], [1n]), [pad('0x1234', { size: 32 })], 3n, 2), // unknown event
    ];
    const out = decodeLogs(logs, [ACC], EP, (bn) => T0 + Number(bn) * 2).map((d) => d.event);
    assert.deepEqual(
      out.map((e) => e.kind + (e.kind === 'outcome' ? `:${e.ok}` : '')),
      ['outcome:true', 'spend', 'outcome:true', 'outcome:false', 'outcome:false', 'frozen', 'unfrozen'],
    );
    const sp = out[1]!;
    assert.ok(sp.kind === 'spend' && sp.amount === 5_000_000n && sp.ts === T0 + 2 && sp.agentKey === KEY);
  });
});

describe('WatcherService', () => {
  it('alarm -> one freeze tx; later alarms of a frozen key send nothing', async () => {
    const s = stubs();
    const freezer = new FreezeSender({ writer: s.writer, reader: s.reader, watcher: WATCHER });
    const svc = new WatcherService({ accounts: [ACC], freezer, reader: s.reader });
    for (let i = 0; i < 3; i++) await svc.ingest(ACC, [{ kind: 'outcome', agentKey: KEY, ok: false, ts: T0 + i }]);
    assert.equal(s.calls.length, 0);
    const r = await svc.ingest(ACC, [{ kind: 'outcome', agentKey: KEY, ok: false, ts: T0 + 3 }]);
    assert.equal(r[0]!.alarm.detector, 'revert_streak');
    assert.equal(r[0]!.freeze?.status, 'sent');
    const r2 = await svc.ingest(ACC, [{ kind: 'spend', agentKey: KEY, asset: USDC, amount: 9_000_000n, ts: T0 + 4 }]);
    assert.equal(r2[0]!.alarm.detector, 'spend_cusum', 'cap read from the chain reader');
    assert.equal(r2[0]!.freeze, null, 'already frozen: no second tx');
    assert.equal(s.calls.length, 1);
    assert.equal(svc.state(T0 + 5).alarms.length, 2);
  });

  it('approval spam freezes; unfreeze resets so a new alarm sends again', async () => {
    const s = stubs();
    const freezer = new FreezeSender({ writer: s.writer, reader: s.reader, watcher: WATCHER });
    const svc = new WatcherService({ accounts: [ACC], freezer, reader: s.reader });
    for (let i = 0; i < 7; i++) await svc.approvalRequest(ACC, KEY, T0 + i);
    assert.equal(s.calls.length, 1);
    await svc.ingest(ACC, [{ kind: 'unfrozen', agentKey: KEY, ts: T0 + 100 }]);
    s.reader.isFrozen = async () => false; // the owner unfroze on-chain
    for (let i = 0; i < 7; i++) await svc.approvalRequest(ACC, KEY, T0 + 200 + i);
    assert.equal(s.calls.length, 2);
  });

  it('a failed freeze is retried on the next tick', async () => {
    const s = stubs({ fail: 1 });
    const freezer = new FreezeSender({ writer: s.writer, reader: s.reader, watcher: WATCHER });
    const svc = new WatcherService({ accounts: [ACC], freezer, reader: s.reader });
    const r = await svc.ingest(ACC, [{ kind: 'spend', agentKey: KEY, asset: USDC, amount: 9_000_000n, ts: T0 }]);
    assert.equal(r[0]!.freeze?.status, 'error');
    assert.equal(svc.pendingRetries(), 1);
    await svc.tick();
    assert.equal(svc.pendingRetries(), 0);
    assert.equal(s.calls.length, 1);
  });

  it('pinned caps work without a reader', async () => {
    const freezer = new FreezeSender({ writer: null, reader: null, watcher: WATCHER });
    const svc = new WatcherService({ accounts: [ACC], freezer, caps: { [USDC]: 20_000_000n } });
    const r = await svc.ingest(ACC, [{ kind: 'spend', agentKey: KEY, asset: USDC, amount: 9_000_000n, ts: T0 }]);
    assert.equal(r[0]!.freeze?.status, 'skipped');
  });
});
