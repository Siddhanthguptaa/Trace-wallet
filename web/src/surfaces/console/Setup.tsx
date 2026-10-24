import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { isAddress, getAddress, type Address } from 'viem';
import s from './console.module.css';
import { PageHead, useOwnerWrite, WriteStatus } from './kit';
import { WalletGate } from '@/components/Chrome';
import { Button, Glass, Hex, TextField } from '@/components/ui';
import { useWallet } from '@/chain/wallet';
import { publicClient } from '@/chain/client';
import { factoryAbi, erc20Abi, accountAbi, RULE_OP, SELECTOR } from '@/chain/abi';
import { usePolicy } from '@/api/queries';
import { config } from '@/config';
import { parseUnits } from '@/domain/units';

export default function Setup() {
  return (
    <>
      <PageHead title="Set up a wallet">
        Deploy an agent wallet you own, give the agent a key, and fund it. Every step is a transaction you sign; nothing here holds
        your keys.
      </PageHead>
      <WalletGate purpose="Connect the wallet that will own the agent wallet.">
        <Steps />
      </WalletGate>
    </>
  );
}

function Steps() {
  const w = useWallet();
  const owner = w.account as Address;
  const [salt, setSalt] = useState(import.meta.env.VITE_SALT ?? '0');
  const [predicted, setPredicted] = useState<Address | null>(null);
  const [deployed, setDeployed] = useState(false);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const factory = config.factoryAddress;
  const saltN = /^\d+$/.test(salt) ? BigInt(salt) : null;

  useEffect(() => {
    let off = false;
    setPredicted(null);
    setLookupErr(null);
    if (!factory || saltN === null) return;
    (async () => {
      try {
        const addr = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'getAddress', args: [owner, saltN] });
        const code = await publicClient.getCode({ address: addr });
        if (!off) {
          setPredicted(addr);
          setDeployed(Boolean(code && code !== '0x'));
        }
      } catch (e) {
        if (!off) setLookupErr((e as Error).message);
      }
    })();
    return () => {
      off = true;
    };
  }, [factory, owner, saltN]);

  const target = predicted ?? owner;
  const deploy = useOwnerWrite(target);
  const keyW = useOwnerWrite(target);
  const attW = useOwnerWrite(target);
  const fundW = useOwnerWrite(target);

  const [agentKey, setAgentKey] = useState(import.meta.env.VITE_AGENT_ADDRESS ?? '');
  const [days, setDays] = useState('7');
  const [attestor, setAttestor] = useState(import.meta.env.VITE_ATTESTOR_ADDRESS ?? '');
  const [amount, setAmount] = useState(import.meta.env.VITE_FUND_USDC ?? '');
  const [token, setToken] = useState(import.meta.env.VITE_USDC_ADDRESS ?? '');
  const [daily, setDaily] = useState(import.meta.env.VITE_DAILY_USDC ?? '');
  const [payee, setPayee] = useState(import.meta.env.VITE_MERCHANT_ADDRESS ?? '');
  const [watcher, setWatcher] = useState(import.meta.env.VITE_WATCHER_ADDRESS ?? '');
  const limW = useOwnerWrite(target);
  const payeeW = useOwnerWrite(target);
  const watchW = useOwnerWrite(target);
  const dailyAmt = (() => {
    try {
      return parseUnits(daily, 6);
    } catch {
      return null;
    }
  })();
  const amt = parseUnits(amount, 6);
  const daysN = /^\d+$/.test(days) ? Number(days) : null;

  const ready = deployed && predicted;
  const policyQ = usePolicy(predicted ?? undefined);

  /**
   * The contract has no addSessionKey: a session key is created by setPolicy(agent, PolicyInput).
   * Copy the limits and call rules of the wallet's first existing key; otherwise build the standard
   * payments policy from the account caps: USDC.transfer to a payee, USDC.approve to a listed spender up to the per-tx cap.
   */
  const buildPolicy = (nowS: number, untilS: number) => {
    const pol = policyQ.data;
    const tmpl = pol?.keys[0];
    const gas = tmpl
      ? { maxCallGas: Number(tmpl.gas.maxCallGas), maxVerificationGas: Number(tmpl.gas.maxVerificationGas), maxPreVerificationGas: Number(tmpl.gas.maxPreVerificationGas), maxFeePerGas: tmpl.gas.maxFeePerGas, gasCredit: tmpl.gas.gasCredit }
      : { maxCallGas: 500_000, maxVerificationGas: 300_000, maxPreVerificationGas: 100_000, maxFeePerGas: 1_000_000_000n, gasCredit: 1_000_000_000_000_000n };
    const half = (c: bigint) => [c / 2n, c - c / 2n] as const;
    const assets = (pol?.assets ?? []).map((a) => {
      const t = tmpl?.assets.find((x) => x.asset.toLowerCase() === a.asset.address.toLowerCase());
      const [burst, rate] = half(t?.cap ?? a.globalCap);
      return { asset: a.asset.address, perTxCap: t?.perTxCap ?? a.globalCap / 2n, burst, ratePerDay: rate };
    });
    const usdc = pol?.assets[0]?.asset.address;
    const calls = tmpl
      ? tmpl.rules.map((r) => ({
          target: r.target,
          selector: r.selector,
          rules: r.args.map((x) => ({ argIndex: x.index, op: RULE_OP[x.op], bound: x.value ? BigInt(x.value) : 0n })),
        }))
      : usdc
        ? [
            { target: usdc, selector: SELECTOR.transfer, rules: [{ argIndex: 0, op: RULE_OP.PAYEE, bound: 0n }] },
            { target: usdc, selector: SELECTOR.approve, rules: [{ argIndex: 0, op: RULE_OP.IN_RECIPIENTS, bound: 0n }, { argIndex: 1, op: RULE_OP.LTE, bound: assets[0]?.perTxCap ?? 0n }] },
          ]
        : [];
    return { validAfter: nowS - 1, validUntil: untilS, gas, assets, calls };
  };

  return (
    <ol className={s.steps}>
      <Glass as="li" pad className={s.stepCard} data-done={deployed}>
        <span className={s.stepNum}>1</span>
        <div className={s.stepBody}>
          <h2>Deploy the wallet</h2>
          {!factory ? (
            <p>No factory address is configured. Set VITE_FACTORY_ADDRESS to deploy from here.</p>
          ) : (
            <>
              <p>The address is known before deployment, so you can fund it first if you like.</p>
              <TextField label="Salt" inputMode="numeric" value={salt} onChange={(e) => setSalt(e.target.value.trim())} error={saltN === null ? 'Use a whole number' : null} />
              {predicted ? (
                <p>
                  Wallet address <Hex value={predicted} /> {deployed ? '(deployed)' : '(not deployed yet)'}
                </p>
              ) : lookupErr ? (
                <p className={s.dim}>Couldn't ask the factory: {lookupErr}</p>
              ) : null}
              {!deployed ? (
                <Button
                  variant="primary"
                  disabled={!predicted || saltN === null || deploy.busy}
                  onClick={async () => {
                    const ok = await deploy.run('Deploy wallet', 'createAccount', [owner, saltN], { address: factory, abi: factoryAbi });
                    if (ok) setDeployed(true);
                  }}
                >
                  Deploy
                </Button>
              ) : null}
              <WriteStatus state={deploy.state} />
            </>
          )}
        </div>
      </Glass>

      <Glass as="li" pad className={s.stepCard}>
        <span className={s.stepNum}>2</span>
        <div className={s.stepBody}>
          <h2>Set the daily limit</h2>
          <p>The most this wallet can move in any 24 hours, split half now and half refilling per day. Do this before giving the agent a key: the key's limits come from it.</p>
          <TextField label="USDC token address" placeholder="0x…" mono value={token} onChange={(e) => setToken(e.target.value.trim())} error={token && !isAddress(token) ? 'Not a valid address' : null} />
          <TextField label="Daily limit (USDC)" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} error={daily && dailyAmt === null ? 'Not a valid amount' : null} />
          <Button
            disabled={!ready || !isAddress(token) || !dailyAmt || dailyAmt <= 0n || limW.busy}
            onClick={() => limW.run('Set daily limit', 'setGlobalCap', [getAddress(token), dailyAmt! / 2n, dailyAmt! - dailyAmt! / 2n])}
          >
            Set daily limit
          </Button>
          <WriteStatus state={limW.state} />
        </div>
      </Glass>

      <Glass as="li" pad className={s.stepCard}>
        <span className={s.stepNum}>3</span>
        <div className={s.stepBody}>
          <h2>Give the agent a key</h2>
          <p>Paste the agent's public address. Its limits and call rules come from the deploy scripts and show up in Policy.</p>
          <TextField label="Agent key address" placeholder="0x…" mono value={agentKey} onChange={(e) => setAgentKey(e.target.value.trim())} error={agentKey && !isAddress(agentKey) ? 'Not a valid address' : null} />
          <TextField label="Valid for (days)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.trim())} error={daysN === null ? 'Use a whole number' : null} hint="A short life limits a leaked key even before you revoke it." />
          <Button
            disabled={!ready || !isAddress(agentKey) || !daysN || keyW.busy || !policyQ.data}
            onClick={() => {
              const now = Math.floor(Date.now() / 1000);
              keyW.run('Add agent key', 'setPolicy', [getAddress(agentKey), buildPolicy(now, now + daysN! * 86_400)], { abi: accountAbi });
            }}
          >
            Add key
          </Button>
          <WriteStatus state={keyW.state} />
        </div>
      </Glass>

      <Glass as="li" pad className={s.stepCard}>
        <span className={s.stepNum}>4</span>
        <div className={s.stepBody}>
          <h2>Connect TRACE (optional)</h2>
          <p>Without an attestor, only payees you list are proven, and everyone else shares the exploration budget.</p>
          <TextField label="Attestor key" placeholder="0x…" mono value={attestor} onChange={(e) => setAttestor(e.target.value.trim())} error={attestor && !isAddress(attestor) ? 'Not a valid address' : null} />
          <Button disabled={!ready || !isAddress(attestor) || attW.busy} onClick={() => attW.run('Set attestor', 'setAttestor', [getAddress(attestor)])}>
            Set attestor
          </Button>
          <WriteStatus state={attW.state} />
        </div>
      </Glass>

      <Glass as="li" pad className={s.stepCard}>
        <span className={s.stepNum}>5</span>
        <div className={s.stepBody}>
          <h2>Fund it</h2>
          <p>Send USDC from your connected wallet. Only fund what you're willing to have bounded, not more.</p>
          <TextField label="USDC token address" placeholder="0x…" mono value={token} onChange={(e) => setToken(e.target.value.trim())} error={token && !isAddress(token) ? 'Not a valid address' : null} />
          <TextField label="Amount (USDC)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={amount && amt === null ? 'Not a valid amount' : null} />
          <Button
            disabled={!predicted || !isAddress(token) || !amt || amt <= 0n || fundW.busy}
            onClick={() => fundW.run('Fund wallet', 'transfer', [predicted, amt], { address: getAddress(token), abi: erc20Abi })}
          >
            Send USDC
          </Button>
          <WriteStatus state={fundW.state} />
          {ready ? (
            <p>
              Done? <Link to={`/console?wallet=${predicted}`}>Open this wallet's console</Link>.
            </p>
          ) : null}
        </div>
      </Glass>

      <Glass as="li" pad className={s.stepCard}>
        <span className={s.stepNum}>6</span>
        <div className={s.stepBody}>
          <h2>List a trusted payee</h2>
          <p>An address you list is a proven payee: the agent can pay it within the normal limits. Everyone else shares the small exploration budget.</p>
          <TextField label="Payee address" placeholder="0x…" mono value={payee} onChange={(e) => setPayee(e.target.value.trim())} error={payee && !isAddress(payee) ? 'Not a valid address' : null} />
          <Button disabled={!ready || !isAddress(payee) || payeeW.busy} onClick={() => payeeW.run('List payee', 'setRecipient', [getAddress(payee), true])}>
            List payee
          </Button>
          <WriteStatus state={payeeW.state} />
        </div>
      </Glass>

      <Glass as="li" pad className={s.stepCard}>
        <span className={s.stepNum}>7</span>
        <div className={s.stepBody}>
          <h2>Let the watcher freeze the agent</h2>
          <p>The watcher can only freeze the agent key, never unfreeze it: only you can.</p>
          <TextField label="Watcher address" placeholder="0x…" mono value={watcher} onChange={(e) => setWatcher(e.target.value.trim())} error={watcher && !isAddress(watcher) ? 'Not a valid address' : null} />
          <Button disabled={!ready || !isAddress(watcher) || watchW.busy} onClick={() => watchW.run('Set watcher', 'setWatcher', [getAddress(watcher)])}>
            Set watcher
          </Button>
          <WriteStatus state={watchW.state} />
        </div>
      </Glass>
    </ol>
  );
}
