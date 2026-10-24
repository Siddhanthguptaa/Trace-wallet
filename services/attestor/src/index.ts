/** @hypnexis/attestor: TRACE scoring port, tier map, EIP-712 signer, outcome ingestion, flag sender (M6). */
export { SERVICE, createApp } from './app.ts';
export { Attestor, EpochUnavailableError, type AttestResult, type AttestorOptions, type ReportResult } from './attestor.ts';
export { buildAttestor } from './build.ts';
export { ACCOUNT_ABI, staticReader, viemChainAccess, type AccountReader, type FlagWriter, type ReceiptVerifier } from './chain.ts';
export { loadAttestorConfig, type AttestorConfig } from './config.ts';
export { decide, type Decision } from './decision.ts';
export { FlagSender, type FlagResult } from './flagSender.ts';
export { ingest, OutcomeBody, type IngestResult } from './outcomes.ts';
export { AttestationSigner, KeySeparationError, assertKeySeparation, type SignedAttestation } from './signer.ts';
export { Store } from './store.ts';
export { coldProfile, scoreAll, volumeUnits, type OutcomeRecord, type PayeeProfile } from './trace/engine.ts';
export * from '../../../packages/shared/src/attestor/index.ts';
