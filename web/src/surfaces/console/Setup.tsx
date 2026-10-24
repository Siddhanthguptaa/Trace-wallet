import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { isAddress, getAddress, type Address } from 'viem';
import s from './console.module.css';
import { PageHead, useOwnerWrite, WriteStatus } from './kit';
import { WalletGate } from '@/components/Chrome';
import { Button, Glass, Hex, TextField } from '@/components/ui';
import { useWallet } from '@/chain/wallet';
import { publicClient } from '@/chain/client';
import { factoryAbi, erc20Abi, accountAbi } from '@/chain/abi';
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
  const [salt, setSalt] = useState('0');
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

  const [agentKey, setAgentKey] = useState('');
  const [days, setDays] = useState('7');
  const [attestor, setAttestor] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('');
  const amt = parseUnits(amount, 6);
  const daysN = /^\d+$/.test(days) ? Number(days) : null;

  const ready = deployed && predicted;

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
          <h2>Give the agent a key</h2>
          <p>Paste the agent's public address. Its limits and call rules come from the deploy scripts and show up in Policy.</p>
          <TextField label="Agent key address" placeholder="0x…" mono value={agentKey} onChange={(e) => setAgentKey(e.target.value.trim())} error={agentKey && !isAddress(agentKey) ? 'Not a valid address' : null} />
          <TextField label="Valid for (days)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.trim())} error={daysN === null ? 'Use a whole number' : null} hint="A short life limits a leaked key even before you revoke it." />
          <Button
            disabled={!ready || !isAddress(agentKey) || !daysN || keyW.busy}
            onClick={() => {
              const now = Math.floor(Date.now() / 1000);
              keyW.run('Add agent key', 'addSessionKey', [getAddress(agentKey), now, now + daysN! * 86_400], { abi: accountAbi });
            }}
          >
            Add key
          </Button>
          <WriteStatus state={keyW.state} />
        </div>
      </Glass>

      <Glass as="li" pad className={s.stepCard}>
        <span className={s.stepNum}>3</span>
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
        <span className={s.stepNum}>4</span>
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
    </ol>
  );
}
