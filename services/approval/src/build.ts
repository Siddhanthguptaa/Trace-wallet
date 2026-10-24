/** Wire config -> store, chain, submitter, service. */
import { BundlerSubmitter, DirectSubmitter, type Submitter } from '../../../packages/shared/src/approval/index.ts';
import { type ApprovalChain, ViemApprovalChain } from './chain.ts';
import type { ApprovalConfig } from './config.ts';
import { ApprovalService } from './service.ts';
import { Store } from './store.ts';

export function buildService(cfg: ApprovalConfig, log?: (m: string) => void, over: { chain?: ApprovalChain; submitter?: Submitter } = {}): ApprovalService {
  if (!cfg.rpcUrl && !over.chain) throw new Error('RPC_URL is required');
  const chain = over.chain ?? new ViemApprovalChain(cfg.chainId, cfg.rpcUrl!);
  let submitter = over.submitter;
  if (!submitter && cfg.bundlerUrl) submitter = new BundlerSubmitter({ bundlerUrl: cfg.bundlerUrl, entryPoint: cfg.entryPoint });
  if (!submitter && cfg.relayerKey && cfg.rpcUrl) {
    submitter = new DirectSubmitter({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, entryPoint: cfg.entryPoint, relayerKey: cfg.relayerKey });
  }
  return new ApprovalService({ cfg, store: new Store(cfg.db), chain, submitter, log });
}
