import { useState } from 'react';
import s from './console.module.css';
import { useConsole, PageHead, Section, OwnerOnly, useOwnerWrite, WriteStatus, assetFor } from './kit';
import { Amount, Button, Glass, Hex, TextField, EmptyState } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { formatUnits, parseUnits, dateTime } from '@/domain/units';
import { SIG_1271_MODE } from '@/chain/abi';
import type { CallRule, Policy as PolicyT } from '@/api/schemas';

type AssetCaps = PolicyT['assets'][number];

export default function Policy() {
  const { wallet, policy, isOwner } = useConsole();
  const p = policy.data!;
  return (
    <>
      <PageHead title="Policy" updatedAt={policy.dataUpdatedAt}>
        Every rule the wallet enforces on the agent. Changes are owner transactions; before you sign, you see how each one moves
        the most the agent could lose.
      </PageHead>

      {p.assets.map((a) => (
        <AccountCaps key={a.asset.address} caps={a} wallet={wallet} isOwner={isOwner} />
      ))}

      <SignatureMode mode={p.sig1271Mode} wallet={wallet} isOwner={isOwner} />

      {p.keys.map((k) => (
        <Glass pad key={k.agentKey}>
          <Section
            title={`Agent key ${k.label ? `“${k.label}”` : ''}`}
            aside={<Hex value={k.agentKey} />}
          >
            <dl className={s.kv}>
              <div>
                <dt>Valid from</dt>
                <dd>{k.validAfter ? dateTime(k.validAfter) : 'Immediately'}</dd>
              </div>
              <div>
                <dt>Valid until</dt>
                <dd>{k.validUntil ? dateTime(k.validUntil) : 'Not set'}</dd>
              </div>
              {k.assets.map((ka) => {
                const as = assetFor(p, ka.asset);
                return as ? (
                  <div key={ka.asset}>
                    <dt>{as.symbol}: per payment / per 24 h</dt>
                    <dd>
                      <Amount value={ka.perTxCap} decimals={as.decimals} /> / <Amount value={ka.cap} decimals={as.decimals} symbol={as.symbol} />
                    </dd>
                  </div>
                ) : null;
              })}
              <div>
                <dt>Max fee per gas</dt>
                <dd>{formatUnits(k.gas.maxFeePerGas, 9, 3)} gwei</dd>
              </div>
              <div>
                <dt>Gas credit left</dt>
                <dd>{formatUnits(k.gas.gasCredit, 18, 6)} ETH</dd>
              </div>
            </dl>
            <h3 className={s.dim} style={{ marginTop: 'var(--s-2)' }}>
              Allowed calls
            </h3>
            {k.rules.length === 0 ? (
              <EmptyState title="No calls allowed">With no rule, every call from this key is refused.</EmptyState>
            ) : (
              <div className={s.rules}>
                {k.rules.map((r) => (
                  <RuleView key={r.target + r.selector} rule={r} wallet={wallet} />
                ))}
              </div>
            )}
            <p className={s.dim}>Changing call rules takes a setPolicy transaction from the deploy scripts. They are shown here so you can check them.</p>
          </Section>
        </Glass>
      ))}

      <Glass pad>
        <Section title="Tracked for metering">
          <p className={s.dim}>The wallet measures these before and after every agent call. Anything else the agent touches is refused by the call rules.</p>
          <dl className={s.kv}>
            <div>
              <dt>Spenders whose allowances count as spend</dt>
              <dd>
                {p.trackedSpenders.length ? (
                  p.trackedSpenders.map((t) => (
                    <div key={t.address}>
                      {t.label ? `${t.label} ` : ''}
                      <Hex value={t.address} />
                    </div>
                  ))
                ) : (
                  <span className={s.dim}>None</span>
                )}
              </dd>
            </div>
            <div>
              <dt>NFT collections that may not leave</dt>
              <dd>
                {p.trackedNFTs.length ? (
                  p.trackedNFTs.map((t) => (
                    <div key={t.address}>
                      {t.label ? `${t.label} ` : ''}
                      <Hex value={t.address} />
                    </div>
                  ))
                ) : (
                  <span className={s.dim}>None</span>
                )}
              </dd>
            </div>
          </dl>
        </Section>
      </Glass>
    </>
  );
}

const OP_TEXT: Record<CallRule['args'][number]['op'], (v?: string) => string> = {
  EQ_SELF: () => 'must be this wallet',
  IN_RECIPIENTS: () => 'must be a listed recipient',
  PAYEE: () => 'is the payee; its track decides the budget',
  LTE: (v) => `at most ${v ?? '?'}`,
  EQ: (v) => `must equal ${v ?? '?'}`,
};

function RuleView({ rule, wallet }: { rule: CallRule; wallet: string }) {
  return (
    <div className={s.rule}>
      <div className={s.ruleHead}>
        <strong>{rule.targetLabel ?? 'Contract'}</strong>
        <Hex value={rule.target} />
        <span className={s.fnSig}>{rule.signature ?? rule.selector}</span>
      </div>
      {rule.args.length ? (
        <ul className={s.ruleArgs}>
          {rule.args.map((a) => (
            <li key={a.index}>
              Argument {a.index}
              {a.name ? ` (${a.name})` : ''} {OP_TEXT[a.op](a.value === wallet ? 'this wallet' : a.value)}
            </li>
          ))}
        </ul>
      ) : (
        <span className={s.dim}>No argument rules. This only suits calls that cannot move value to a third party.</span>
      )}
    </div>
  );
}

function AccountCaps({ caps, wallet, isOwner }: { caps: AssetCaps; wallet: `0x${string}`; isOwner: boolean }) {
  const { asset } = caps;
  const writer = useOwnerWrite(wallet);
  const [editing, setEditing] = useState(false);
  const fmt = (v: bigint) => formatUnits(v, asset.decimals, asset.decimals).replace(/,/g, '').replace(/\.?0+$/, '');
  const [g, setG] = useState(fmt(caps.globalCap));
  const [e, setE] = useState(fmt(caps.exploreCap));
  const [t, setT] = useState(fmt(caps.explorePerTxCap));
  const ng = parseUnits(g, asset.decimals);
  const ne = parseUnits(e, asset.decimals);
  const nt = parseUnits(t, asset.decimals);
  const valid = ng !== null && ne !== null && nt !== null && ne <= ng && nt <= ne;
  const changedG = ng !== null && ng !== caps.globalCap;
  const changedE = (ne !== null && ne !== caps.exploreCap) || (nt !== null && nt !== caps.explorePerTxCap);

  const save = async () => {
    if (!valid) return;
    if (changedG) {
      const ok = await writer.run(`Set ${asset.symbol} account cap`, 'setGlobalCap', [asset.address, ng]);
      if (!ok) return;
    }
    if (changedE) {
      const ok = await writer.run(`Set ${asset.symbol} exploration caps`, 'setExploreCaps', [asset.address, ne, nt]);
      if (!ok) return;
    }
    setEditing(false);
  };

  return (
    <Glass pad>
      <div className={s.assetHead}>
        <h3>Account-wide limits · {asset.symbol}</h3>
        {isOwner && !editing ? (
          <Button size="small" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
      </div>
      <dl className={s.capGrid}>
        <div className={s.capCell}>
          <dt>Account cap per 24 h, all keys and tracks</dt>
          <dd>
            <Amount value={caps.globalCap} decimals={asset.decimals} symbol={asset.symbol} />
          </dd>
        </div>
        <div className={s.capCell}>
          <dt>Exploration budget per 24 h (unproven payees)</dt>
          <dd>
            <Amount value={caps.exploreCap} decimals={asset.decimals} symbol={asset.symbol} />
          </dd>
        </div>
        <div className={s.capCell}>
          <dt>Per payment to an unproven payee</dt>
          <dd>
            <Amount value={caps.explorePerTxCap} decimals={asset.decimals} symbol={asset.symbol} />
          </dd>
        </div>
      </dl>
      <OwnerOnly isOwner={isOwner} />
      {editing ? (
        <div className={s.editor}>
          <div className={s.editorFields}>
            <TextField label={`Account cap (${asset.symbol})`} inputMode="decimal" value={g} onChange={(x) => setG(x.target.value)} error={ng === null ? 'Not a valid amount' : null} />
            <TextField
              label={`Exploration budget (${asset.symbol})`}
              inputMode="decimal"
              value={e}
              onChange={(x) => setE(x.target.value)}
              error={ne === null ? 'Not a valid amount' : ng !== null && ne > ng ? 'Cannot exceed the account cap' : null}
              hint="Default is 5% of the account cap"
            />
            <TextField
              label={`Per unproven payment (${asset.symbol})`}
              inputMode="decimal"
              value={t}
              onChange={(x) => setT(x.target.value)}
              error={nt === null ? 'Not a valid amount' : ne !== null && nt > ne ? 'Cannot exceed the exploration budget' : null}
              hint="Default is 1% of the account cap"
            />
          </div>
          {valid && (changedG || changedE) ? (
            <BoundCheck before={caps.globalCap} after={ng!} beforeE={caps.exploreCap} afterE={ne!} decimals={asset.decimals} symbol={asset.symbol} />
          ) : null}
          <div className={s.editorActions}>
            <Button variant="primary" onClick={save} disabled={!valid || (!changedG && !changedE) || writer.busy}>
              {writer.busy ? 'Working…' : changedG && changedE ? 'Sign 2 transactions' : 'Sign change'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={writer.busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <WriteStatus state={writer.state} />
    </Glass>
  );
}

function BoundCheck({ before, after, beforeE, afterE, decimals, symbol }: { before: bigint; after: bigint; beforeE: bigint; afterE: bigint; decimals: number; symbol: string }) {
  const up = after > before || afterE > beforeE;
  const parts: string[] = [];
  if (after !== before) parts.push(`max 24 h loss ${formatUnits(before, decimals)} → ${formatUnits(after, decimals)} ${symbol}`);
  if (afterE !== beforeE) parts.push(`max to strangers ${formatUnits(beforeE, decimals)} → ${formatUnits(afterE, decimals)} ${symbol}`);
  return (
    <p className={s.boundCheck} data-dir={up ? 'up' : 'down'} role="note">
      <Icon name={up ? 'alert' : 'check'} size={16} />
      {up ? 'Raises' : 'Lowers'} {parts.join('; ')}.
    </p>
  );
}

function SignatureMode({ mode, wallet, isOwner }: { mode: PolicyT['sig1271Mode']; wallet: `0x${string}`; isOwner: boolean }) {
  const writer = useOwnerWrite(wallet);
  const [sel, setSel] = useState(mode);
  return (
    <Glass pad>
      <Section title="Signature door (ERC-1271)">
        <div className={s.mode} role="radiogroup" aria-label="Signature mode">
          <label className={s.modeOpt}>
            <input type="radio" name="mode" checked={sel === 'OWNER_ONLY'} onChange={() => setSel('OWNER_ONLY')} disabled={!isOwner} />
            <span>
              <strong>Owner only</strong>
              <span>The wallet refuses every agent signature. x402 runs through a small capped float wallet instead. Safest.</span>
            </span>
          </label>
          <label className={s.modeOpt}>
            <input
              type="radio"
              name="mode"
              checked={sel === 'OWNER_PLUS_X402_VOUCHER'}
              onChange={() => setSel('OWNER_PLUS_X402_VOUCHER')}
              disabled={!isOwner}
            />
            <span>
              <strong>Owner, plus pre-paid x402 vouchers</strong>
              <span>
                The agent can pay x402 natively, but only for a voucher a policy-checked operation registered and paid for first.
                Any other agent signature is still refused.
              </span>
            </span>
          </label>
        </div>
        <OwnerOnly isOwner={isOwner} />
        {isOwner && sel !== mode ? (
          <div className={s.editorActions}>
            <Button variant="primary" disabled={writer.busy} onClick={() => writer.run('Change signature mode', 'setSig1271Mode', [SIG_1271_MODE[sel]])}>
              Sign change
            </Button>
          </div>
        ) : null}
        <WriteStatus state={writer.state} />
      </Section>
    </Glass>
  );
}
