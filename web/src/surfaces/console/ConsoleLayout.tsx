import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { isAddress, getAddress, type Address } from 'viem';
import s from './console.module.css';
import { SiteHeader, AccountChip } from '@/components/Chrome';
import { Button, ErrorState, Glass, Hex, Loading, TextField } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useApprovals, usePolicy } from '@/api/queries';
import { useWallet } from '@/chain/wallet';
import { config, CHAIN_NAMES } from '@/config';
import type { ConsoleCtx } from './kit';

const NAV = [
  { to: '/console', label: 'Overview', end: true },
  { to: '/console/policy', label: 'Policy' },
  { to: '/console/payees', label: 'Payees' },
  { to: '/console/approvals', label: 'Approvals' },
  { to: '/console/activity', label: 'Activity' },
  { to: '/console/keys', label: 'Keys & safety' },
  { to: '/console/setup', label: 'Setup' },
];

export default function ConsoleLayout() {
  const [params] = useSearchParams();
  const param = params.get('wallet');
  const wallet = (param && isAddress(param) ? getAddress(param) : config.walletAddress) as Address | undefined;
  const w = useWallet();
  const policy = usePolicy(wallet);
  const pending = useApprovals(wallet, 'pending');
  const isOwner = Boolean(policy.data && w.account && policy.data.owner.toLowerCase() === w.account.toLowerCase());
  const q = wallet ? `?wallet=${wallet}` : '';
  const isSetup = useLocation().pathname.startsWith('/console/setup');

  return (
    <div className={s.shell}>
      <SiteHeader right={<AccountChip />} />
      <div className={s.body}>
        <nav className={s.side} aria-label="Console">
          {wallet ? (
            <div className={s.walletCard}>
              <span className={s.walletLabel}>Wallet on {CHAIN_NAMES[config.chainId] ?? `chain ${config.chainId}`}</span>
              <Hex value={wallet} />
              <span className={s.role} data-owner={isOwner}>
                <Icon name={isOwner ? 'key' : 'lock'} size={14} />
                {isOwner ? 'You are the owner' : w.account ? 'Read-only: not the owner' : 'Read-only'}
              </span>
            </div>
          ) : null}
          <ul className={s.navList}>
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to + q} end={n.end} className={({ isActive }) => (isActive ? s.navOn : undefined)}>
                  {n.label}
                  {n.label === 'Approvals' && pending.data && pending.data.length > 0 ? (
                    <span className={s.count} aria-label={`${pending.data.length} pending`}>
                      {pending.data.length}
                    </span>
                  ) : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className={s.main}>
          {isSetup ? (
            <Outlet context={{ wallet: wallet as Address, policy, isOwner } satisfies ConsoleCtx} />
          ) : !wallet ? (
            <ChooseWallet />
          ) : policy.isPending ? (
            <Glass>
              <Loading lines={6} label="Loading the wallet" />
            </Glass>
          ) : policy.isError ? (
            <Glass>
              <ErrorState error={policy.error} title="Can't read this wallet's policy" onRetry={() => policy.refetch()} />
            </Glass>
          ) : (
            <Outlet context={{ wallet, policy, isOwner } satisfies ConsoleCtx} />
          )}
        </main>
      </div>
    </div>
  );
}

function ChooseWallet() {
  const [value, setValue] = useState('');
  const nav = useNavigate();
  const err = value && !isAddress(value) ? 'Not a valid address' : null;
  return (
    <Glass pad className={s.choose}>
      <h1>Which wallet?</h1>
      <p className={s.pageLede}>Enter the agent wallet's address to open it. Anyone can read it; only the owner can change it.</p>
      <form
        className={s.chooseForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (isAddress(value)) nav(`/console?wallet=${getAddress(value)}`);
        }}
      >
        <TextField label="Wallet address" placeholder="0x…" mono value={value} onChange={(e) => setValue(e.target.value.trim())} error={err} />
        <Button type="submit" variant="primary" disabled={!isAddress(value)}>
          Open wallet
        </Button>
      </form>
      <p className={s.dim}>
        No wallet yet? <Link to="/console/setup">Deploy one</Link>.
      </p>
    </Glass>
  );
}
