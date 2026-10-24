/** What the owner console is told. Browser-safe. Addresses and policy numbers only, NEVER a key. */
export interface PublicConfig {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  entryPoint: string;
  usdc: string;
  usdcDecimals: number;
  /** the MetaMask account that must be connected */
  owner: string;
  factory: string;
  account: string;
  salt: string;
  agent: string;
  attestor: string;
  watcher: string;
  attacker: string;
  guardians: string[];
  merchant: string;
  policy: { burst: string; rate: string; perTx: string; days: number; depositWei: string; gasCreditWei: string };
  freeze: { velocityBps: number; sprayMax: number; strikeMax: number };
  urls: { attestor: string; approval: string; watcher: string };
  /** how many successful owner-signed outcomes make a payee PROVEN in the attestor */
  outcomeVouches: number;
}
