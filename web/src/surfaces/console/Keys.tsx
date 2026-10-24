import { useState } from 'react';
import { isAddress, getAddress } from 'viem';
import s from './console.module.css';
import { useConsole, PageHead, Section, OwnerOnly, useOwnerWrite, WriteStatus } from './kit';
import { keyStatus } from './Overview';
import { Button, Glass, Hex, HoldButton, TextField, EmptyState } from '@/components/ui';
import { formatUnits, parseUnits, dateTime } from '@/domain/units';
import type { SessionKey } from '@/api/schemas';

const STATUS_LABEL = { active: 'Active', expiring: 'Expires within a day', expired: 'Expired', revoked: 'Revoked', scheduled: 'Not yet valid' };

export default function Keys() {
  const { wallet, policy, isOwner } = useConsole();
  const p = policy.data!;
  const writer = useOwnerWrite(wallet);
  const [attestor, setAttestor] = useState('');
  const attErr = attestor && !isAddress(attestor) ? 'Not a valid address' : null;

  return (
    <>
      <PageHead title="Keys & safety" updatedAt={policy.dataUpdatedAt}>
        The agent's keys and the switches that stop them. Revoking takes effect in the next block; no agent operation validates
        after it.
      </PageHead>

      {p.keys.length === 0 ? (
        <Glass pad>
          <EmptyState title="No agent key">Add one from Setup.</EmptyState>
        </Glass>
      ) : (
        p.keys.map((k) => <KeyCard key={k.agentKey} k={k} wallet={wallet} isOwner={isOwner} />)
      )}

      <Glass pad>
        <Section title="TRACE attestor">
          <dl className={s.kv}>
            <div>
              <dt>Current attestor</dt>
              <dd>{p.attestor ? <Hex value={p.attestor} /> : <span className={s.dim}>None</span>}</dd>
            </div>
            <div>
              <dt>Epoch</dt>
              <dd>{p.attestEpoch}</dd>
            </div>
          </dl>
          {isOwner ? (
            <>
              <form
                className={s.inline}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (isAddress(attestor)) writer.run('Set attestor', 'setAttestor', [getAddress(attestor)]).then((ok) => ok && setAttestor(''));
                }}
              >
                <TextField label="New attestor key" placeholder="0x…" mono value={attestor} onChange={(e) => setAttestor(e.target.value.trim())} error={attErr} />
                <Button type="submit" disabled={!isAddress(attestor) || writer.busy}>
                  Set attestor
                </Button>
              </form>
              <div className={s.editorActions}>
                <HoldButton disabled={writer.busy} onConfirm={() => writer.run('Void all attestations', 'bumpEpoch', [])}>
                  Hold to void every attestation
                </HoldButton>
              </div>
              <p className={s.dim}>
                If the attestor key leaks, void every attestation. All attested payees drop to unproven, so the leak costs at most
                the exploration budget.
              </p>
            </>
          ) : null}
          <OwnerOnly isOwner={isOwner} />
          <WriteStatus state={writer.state} />
        </Section>
      </Glass>
    </>
  );
}

function KeyCard({ k, wallet, isOwner }: { k: SessionKey; wallet: `0x${string}`; isOwner: boolean }) {
  const writer = useOwnerWrite(wallet);
  const st = keyStatus(k);
  const [newKey, setNewKey] = useState('');
  const [gas, setGas] = useState('');
  const gasWei = parseUnits(gas, 18);
  const newErr = newKey && !isAddress(newKey) ? 'Not a valid address' : null;
  const live = !k.revoked;

  return (
    <Glass pad>
      <Section
        title={k.label ? `Agent key “${k.label}”` : 'Agent key'}
        aside={
          <span className={s.status} data-s={st}>
            <span className={s.statusDot} aria-hidden="true" />
            {STATUS_LABEL[st]}
          </span>
        }
      >
        <dl className={s.kv}>
          <div>
            <dt>Address</dt>
            <dd>
              <Hex value={k.agentKey} />
            </dd>
          </div>
          <div>
            <dt>Valid until</dt>
            <dd>{k.validUntil ? dateTime(k.validUntil) : 'Not set'}</dd>
          </div>
          <div>
            <dt>Gas credit left</dt>
            <dd>{formatUnits(k.gas.gasCredit, 18, 6)} ETH</dd>
          </div>
          <div>
            <dt>Max fee per gas</dt>
            <dd>{formatUnits(k.gas.maxFeePerGas, 9, 3)} gwei</dd>
          </div>
        </dl>

        {isOwner && live ? (
          <>
            <HoldButton disabled={writer.busy} onConfirm={() => writer.run('Revoke agent key', 'revokeKey', [k.agentKey])}>
              Hold to revoke this key
            </HoldButton>
            <form
              className={s.inline}
              onSubmit={(e) => {
                e.preventDefault();
                if (isAddress(newKey)) writer.run('Rotate agent key', 'rotateKey', [k.agentKey, getAddress(newKey)]).then((ok) => ok && setNewKey(''));
              }}
            >
              <TextField
                label="Rotate to a new key"
                placeholder="0x…"
                mono
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.trim())}
                error={newErr}
                hint="The old key stops working; limits and rules carry over."
              />
              <Button type="submit" disabled={!isAddress(newKey) || writer.busy}>
                Rotate
              </Button>
            </form>
            <form
              className={s.inline}
              onSubmit={(e) => {
                e.preventDefault();
                if (gasWei && gasWei > 0n) writer.run('Refill gas credit', 'refillGasCredit', [k.agentKey, gasWei]).then((ok) => ok && setGas(''));
              }}
            >
              <TextField
                label="Add gas credit (ETH)"
                placeholder="0.01"
                inputMode="decimal"
                value={gas}
                onChange={(e) => setGas(e.target.value)}
                error={gas && gasWei === null ? 'Not a valid amount' : null}
                hint="Paid from the wallet's own ETH. The agent can never spend more gas than this."
              />
              <Button type="submit" disabled={!gasWei || gasWei <= 0n || writer.busy}>
                Add credit
              </Button>
            </form>
          </>
        ) : null}
        <OwnerOnly isOwner={isOwner} />
        <WriteStatus state={writer.state} />
      </Section>
    </Glass>
  );
}
