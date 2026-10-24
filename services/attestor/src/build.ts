/** Wires an Attestor from config: chain access when RPC_URL is set, else static owners/epoch. */
import { Attestor } from './attestor.ts';
import { staticReader, viemChainAccess } from './chain.ts';
import type { AttestorConfig } from './config.ts';
import { AttestationSigner } from './signer.ts';
import { Store } from './store.ts';

export function buildAttestor(cfg: AttestorConfig, log?: (m: string) => void): Attestor {
  // Throws KeySeparationError before anything else is created [A20].
  const signer = new AttestationSigner(cfg.attestorKey, { agents: cfg.agents, verifiers: cfg.verifiers, ttlSeconds: cfg.ttlSeconds });
  const store = new Store(cfg.dbPath);
  const common = {
    chainId: cfg.chainId,
    signer,
    store,
    verifiers: cfg.verifiers,
    agents: cfg.agents,
    mode: cfg.mode,
    scriptedTiers: cfg.scriptedTiers,
    roundSeconds: cfg.roundSeconds,
    wallets: cfg.wallets,
    log,
  };
  if (cfg.rpcUrl) {
    const chain = viemChainAccess({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, attestorKey: cfg.attestorKey });
    return new Attestor({ ...common, reader: chain.reader, writer: chain.writer, receipts: chain.receipts });
  }
  // No chain: owner-signed outcomes use the OWNERS map; x402 receipts cannot be verified (rejected);
  // flags are recorded but cannot be sent.
  const reader = staticReader({ owners: cfg.owners, attestor: signer.address, epoch: cfg.defaultEpoch });
  return new Attestor({ ...common, reader, writer: null, receipts: null, defaultEpoch: cfg.defaultEpoch });
}
