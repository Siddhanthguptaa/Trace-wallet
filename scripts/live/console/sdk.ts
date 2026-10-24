/**
 * Browser SDK entry (bundled by the console server to /sdk.js as the global `HypnexisOwner`).
 * NOT a frontend: it is the wallet logic a frontend calls. Everything goes through `window.ethereum`
 * (MetaMask); the owner key never touches the SDK or the server.
 *
 *   const cfg = await (await fetch('/config.json')).json();
 *   await HypnexisOwner.connect(window.ethereum, cfg);
 *   HypnexisOwner.previewAction(cfg, HypnexisOwner.actionById('setGlobalCap'));   // plain words, BEFORE the popup
 *   await HypnexisOwner.runAction(window.ethereum, cfg, 'setGlobalCap');
 */
export * from './core.ts';
export { OWNER_ACTIONS, SETUP_ACTIONS, actionById, demoPolicy, FREEZE_KEY } from '../lib/ownerActions.ts';
export type { OwnerAction, TxSpec } from '../lib/ownerActions.ts';
export type { PublicConfig } from '../lib/config.ts';
