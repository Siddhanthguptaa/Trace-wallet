import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import s from './approve.module.css';
import { useApproval, usePolicy, qk } from '@/api/queries';
import { approvals } from '@/api/clients';
import { ApiError } from '@/api/http';
import type { ApprovalRequest } from '@/api/schemas';
import { useWallet } from '@/chain/wallet';
import { chain } from '@/chain/client';
import { WalletGate, DoorMark } from '@/components/Chrome';
import { Amount, Button, ErrorState, Glass, Hex, Loading, TrackBadge, TxProgress } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { dateTime, formatUnits, relativeTime } from '@/domain/units';

const STEPS = ['Signed', 'Relayed', 'Executed'];

function progressOf(status: ApprovalRequest['status']): { current: number; failed: boolean } | null {
  switch (status) {
    case 'signed':
      return { current: 1, failed: false };
    case 'relayed':
      return { current: 2, failed: false };
    case 'executed':
    case 'used':
      return { current: 3, failed: false };
    case 'reverted':
      return { current: 2, failed: true };
    default:
      return null;
  }
}

export default function Approve() {
  const { id } = useParams();
  const q = useApproval(id);

  return (
    <div className={s.page}>
      <header className={s.top}>
        <Link to="/" className={s.mark} aria-label="trace-wallet">
          <DoorMark size={20} />
        </Link>
        <span className={s.topTitle}>Payment approval</span>
      </header>
      <main className={s.main}>
        {q.isPending ? (
          <Glass level={2}>
            <Loading lines={5} label="Loading the request" />
          </Glass>
        ) : q.isError ? (
          <Glass level={2}>
            {q.error instanceof ApiError && q.error.status === 404 ? (
              <ErrorState error={q.error} title="This request does not exist" />
            ) : (
              <ErrorState error={q.error} title="Couldn't load this request" onRetry={() => q.refetch()} />
            )}
          </Glass>
        ) : (
          <Request req={q.data} />
        )}
      </main>
    </div>
  );
}

function Request({ req }: { req: ApprovalRequest }) {
  const w = useWallet();
  const qc = useQueryClient();
  const policy = usePolicy(req.wallet);
  const [busy, setBusy] = useState<'sign' | 'decline' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);

  const expired = req.status === 'expired' || (req.status === 'pending' && req.expiresAt * 1000 < Date.now());
  const owner = policy.data?.owner;
  const notOwner = Boolean(owner && w.account && owner.toLowerCase() !== w.account.toLowerCase());
  const progress = progressOf(req.status);
  const canDecide = req.status === 'pending' && !expired;
  const wrongChain = req.chainId !== chain.id;

  const blocker = useMemo(() => {
    if (!req.simulated) return 'The service could not simulate this call, so the real effect is unknown. Signing is disabled until it can.';
    if (!req.typedData) return 'The service did not provide the data to sign.';
    if (wrongChain) return `This request is for chain ${req.chainId}, but this app is set to ${chain.name}.`;
    if (notOwner) return 'The connected account is not the owner of this wallet. Only the owner can approve.';
    return null;
  }, [req, wrongChain, notOwner]);

  const sign = async () => {
    if (!req.typedData) return;
    setErr(null);
    setBusy('sign');
    try {
      const sig = await w.signTypedData(req.typedData);
      const updated = await approvals.postSignature(req.id, sig);
      qc.setQueryData(qk.approval(req.id), updated);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    setErr(null);
    setBusy('decline');
    try {
      const sig = await w.signMessage(`Hypnexis approval service: reject request ${req.id}`);
      const updated = await approvals.decline(req.id, sig);
      qc.setQueryData(qk.approval(req.id), updated);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const fn = req.decoded.functionSignature.split('(')[0];
  const target = req.decoded.targetLabel ?? req.targetLabel;

  return (
    <article className={s.card} aria-labelledby="amount">
      <Glass level={2} className={s.sheet}>
        <div className={s.head}>
          <span className={s.wallet}>
            <Icon name="wallet" size={16} /> <Hex value={req.wallet} />
          </span>
          <span className={s.expiry}>
            <Icon name="clock" size={15} />
            {expired ? 'Expired' : `Expires ${relativeTime(req.expiresAt)}`}
          </span>
        </div>

        <h1 id="amount" className={s.amount}>
          <Amount value={req.maxOutflow} decimals={req.asset.decimals} symbol={req.asset.symbol} sign="out" />
        </h1>
        <div className={s.payee}>
          <span className={s.to}>to</span>
          <Hex value={req.payee} />
          <TrackBadge
            track={req.payeeTrack}
            detail={req.payeeTrack === 'unproven' ? 'not in your list' : req.payeeTrack === 'flagged' ? 'flagged' : undefined}
          />
        </div>

        <section className={s.block} aria-labelledby="what">
          <h2 id="what">What will happen</h2>
          <dl className={s.facts}>
            <div>
              <dt>Call</dt>
              <dd>
                <span className={s.call}>
                  {target ? `${target}.` : ''}
                  {fn}(
                  {req.decoded.args.map((a, i) => (
                    <span key={a.name + i}>
                      {i ? ', ' : ''}
                      <span className={s.argName}>{a.name}</span> {a.value.startsWith('0x') && a.value.length === 42 ? shortAddr(a.value, req.wallet) : a.value}
                    </span>
                  ))}
                  )
                </span>
                <Hex value={req.decoded.target} />
              </dd>
            </div>
            <div>
              <dt>Effect on your wallet</dt>
              <dd>
                {req.simulated ? (
                  <ul className={s.deltas}>
                    {req.simulated.deltas.map((d) => (
                      <li key={d.label + d.kind}>
                        <span className={d.delta < 0n ? s.neg : s.pos}>
                          {d.delta > 0n ? '+' : ''}
                          {formatUnits(d.delta, d.decimals ?? 0)}
                        </span>{' '}
                        {d.label}
                        {d.kind === 'allowance' ? <span className={s.dim}> allowance</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className={s.dim}>Simulation unavailable</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd className="num">{dateTime(req.validUntil)}</dd>
            </div>
          </dl>
        </section>

        <section className={s.note}>
          <button type="button" className={s.noteToggle} aria-expanded={noteOpen} onClick={() => setNoteOpen((v) => !v)}>
            <span>
              <strong>The agent's own words</strong>
              <span className={s.untrusted}>untrusted</span>
            </span>
            <Icon name="chevronDown" size={16} className={noteOpen ? s.rot : undefined} />
          </button>
          {noteOpen ? (
            <p className={s.noteText}>
              {req.agentNote ? <s>{req.agentNote}</s> : <span className={s.dim}>The agent left no note.</span>}
              <span className={s.noteWhy}>
                Written by the agent, which may be hijacked. This screen is built from the decoded call and the simulated
                effect instead.
              </span>
            </p>
          ) : null}
        </section>

        {req.typedData ? (
          <details className={s.signing}>
            <summary>
              What you are signing <span className={s.dim}>(MetaMask will show the same fields)</span>
            </summary>
            <dl className={s.typed}>
              <div>
                <dt>Type</dt>
                <dd>{req.typedData.primaryType}</dd>
              </div>
              <div>
                <dt>Chain</dt>
                <dd className="num">{req.typedData.domain.chainId}</dd>
              </div>
              <div>
                <dt>Wallet contract</dt>
                <dd>
                  <Hex value={req.typedData.domain.verifyingContract} />
                </dd>
              </div>
              {Object.entries(req.typedData.message).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{renderTyped(k, v, req)}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}

        <div className={s.actions}>
          {progress ? (
            <div className={s.result} role="status" aria-live="polite">
              <TxProgress steps={STEPS} current={progress.current} failed={progress.failed} />
              {req.status === 'executed' || req.status === 'used' ? (
                <p className={s.resultLine}>
                  <Icon name="check" size={16} /> Paid. The contract checked the outflow against what you signed.
                </p>
              ) : req.status === 'reverted' ? (
                <p className={`${s.resultLine} ${s.neg}`}>
                  <Icon name="cross" size={16} /> Reverted{req.revertReason ? `: ${req.revertReason}` : ''}. No funds moved.
                </p>
              ) : (
                <p className={s.resultLine}>Waiting for the transaction…</p>
              )}
              {req.txHash ? <Hex value={req.txHash} kind="tx" /> : null}
            </div>
          ) : req.status === 'declined' ? (
            <p className={s.resultLine} role="status">
              You declined this request. Nothing was signed.
            </p>
          ) : expired ? (
            <p className={s.resultLine} role="status">
              This request expired before anyone signed it. The agent has to ask again.
            </p>
          ) : canDecide ? (
            <WalletGate purpose="Sign with the owner key to approve this exact payment.">
              {blocker ? <p className={s.blocker}>{blocker}</p> : null}
              {err ? (
                <p className={s.blocker} role="alert">
                  {err}
                </p>
              ) : null}
              <div className={s.buttons}>
                <Button variant="decide" block onClick={sign} disabled={Boolean(blocker) || busy !== null}>
                  {busy === 'sign' ? 'Check MetaMask…' : 'Sign with MetaMask'}
                </Button>
                <Button block onClick={decline} disabled={busy !== null}>
                  {busy === 'decline' ? 'Declining…' : 'Decline'}
                </Button>
              </div>
              <p className={s.fine}>
                You approve at most{' '}
                <Amount value={req.maxOutflow} decimals={req.asset.decimals} symbol={req.asset.symbol} /> to this payee, once,
                before {dateTime(req.validUntil)}. If more leaves, the wallet reverts the call.
              </p>
            </WalletGate>
          ) : (
            <p className={s.resultLine}>This request is {req.status}.</p>
          )}
        </div>
      </Glass>
      {req.rateLimited ? (
        <p className={s.rate}>This agent key has hit its limit of open requests. Older requests must be answered first.</p>
      ) : null}
    </article>
  );
}

function shortAddr(v: string, wallet: string) {
  return v.toLowerCase() === wallet.toLowerCase() ? 'this wallet' : `${v.slice(0, 6)}…${v.slice(-4)}`;
}

function renderTyped(key: string, v: unknown, req: ApprovalRequest) {
  const str = String(v);
  if (/^0x[0-9a-fA-F]{40}$/.test(str)) return <Hex value={str} />;
  if (key.toLowerCase().includes('outflow') && /^\d+$/.test(str))
    return (
      <span className="num">
        <Amount value={BigInt(str)} decimals={req.asset.decimals} symbol={req.asset.symbol} />{' '}
        <span className={s.dim}>({str})</span>
      </span>
    );
  if (key.toLowerCase().includes('until') && /^\d+$/.test(str)) return <span className="num">{dateTime(Number(str))}</span>;
  if (/^0x[0-9a-fA-F]{64}$/.test(str)) return <code className={s.hash}>{`${str.slice(0, 10)}…${str.slice(-8)}`}</code>;
  return <span className="num">{str}</span>;
}
