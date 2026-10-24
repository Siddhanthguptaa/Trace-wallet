import { NavLink, Link } from 'react-router-dom';
import s from './chrome.module.css';
import { useWallet } from '@/chain/wallet';
import { chain } from '@/chain/client';
import { Button, ButtonA } from './ui';
import { Icon } from './Icon';
import { shortHex } from '@/domain/units';
import type { ReactNode } from 'react';

export const PAPER_URL = 'https://zenodo.org/records/22706499';

/** The silver ground: a soft studio light from above, faint aubergine and marigold washes. */
export function Backdrop({ drift = false }: { drift?: boolean }) {
  return (
    <div className={s.backdrop} data-drift={drift ? 'on' : 'off'} aria-hidden="true">
      <span className={s.fieldA} />
      <span className={s.fieldB} />
    </div>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? s.navOn : undefined)}>
      <span data-label={label}>{label}</span>
    </NavLink>
  );
}

export function SiteHeader({ right, overlay = false }: { right?: ReactNode; overlay?: boolean }) {
  return (
    <header className={s.navbar} data-overlay={overlay}>
      <div className={s.navInner}>
        <Link to="/" className={s.wordmark} aria-label="trace-wallet, home">
          <DoorMark />
          <span>
            trace<em>-wallet</em>
          </span>
        </Link>
        <nav className={s.nav} aria-label="Main">
          <NavItem to="/demo" label="Live demo" />
          <NavItem to="/console" label="Console" />
          <a href={PAPER_URL} target="_blank" rel="noreferrer">
            <span data-label="Paper">Paper</span>
          </a>
        </nav>
        {right ? <div className={s.right}>{right}</div> : null}
      </div>
    </header>
  );
}

export function DoorMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6.5" y="3" width="11" height="18" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="14.4" cy="12.3" r="1.35" fill="var(--mari)" />
      <line x1="3" y1="21" x2="21" y2="21" stroke="var(--mari)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Wallet preconditions, in order: provider, account, network. */
export function WalletGate({ children, purpose }: { children: ReactNode; purpose: string }) {
  const w = useWallet();
  if (!w.hasProvider) {
    return (
      <div className={s.gate}>
        <h2>Open this in MetaMask</h2>
        <p>{purpose} No wallet was found in this browser.</p>
        <div className={s.gateActions}>
          <ButtonA variant="primary" href={w.metamaskDeepLink}>
            Open in MetaMask
          </ButtonA>
          <ButtonA href="https://metamask.io/download/" target="_blank" rel="noreferrer">
            Get MetaMask
          </ButtonA>
        </div>
      </div>
    );
  }
  if (!w.account) {
    return (
      <div className={s.gate}>
        <h2>Connect the owner wallet</h2>
        <p>{purpose}</p>
        <div className={s.gateActions}>
          <Button variant="primary" onClick={w.connect} disabled={w.connecting}>
            <Icon name="wallet" size={17} />
            {w.connecting ? 'Waiting for MetaMask…' : 'Connect MetaMask'}
          </Button>
        </div>
        {w.error ? <p className={s.gateError}>{w.error}</p> : null}
      </div>
    );
  }
  if (w.chainId !== chain.id) {
    return (
      <div className={s.gate}>
        <h2>Switch to {chain.name}</h2>
        <p>The wallet lives on {chain.name}. Your MetaMask is on another network, so nothing here would match.</p>
        <div className={s.gateActions}>
          <Button variant="primary" onClick={w.switchChain}>
            Switch network
          </Button>
        </div>
        {w.error ? <p className={s.gateError}>{w.error}</p> : null}
      </div>
    );
  }
  return <>{children}</>;
}

export function AccountChip() {
  const w = useWallet();
  if (!w.hasProvider) return null;
  if (!w.account)
    return (
      <Button size="small" onClick={w.connect} disabled={w.connecting}>
        Connect
      </Button>
    );
  return (
    <span className={s.chip} title={w.account}>
      <span className={s.chipDot} data-ok={w.chainId === chain.id} aria-hidden="true" />
      <span className="mono">{shortHex(w.account)}</span>
    </span>
  );
}
