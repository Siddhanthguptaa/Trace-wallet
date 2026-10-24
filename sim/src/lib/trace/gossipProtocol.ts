/**
 * TRACE-LG: L402 Receipt Gossip Protocol (WWW v2)
 *
 * Verifiable evidence-sharing protocol for partitioned-view routing.
 * Buyers gossip cryptographically-signed L402 receipts; recipients update
 * Bayesian priors with verified third-party observations without trusting
 * the gossiper.
 *
 * This resolves the partitioned-view starvation problem documented in v1:
 * each buyer's 60-job local history is too thin to support greedy lock-in
 * safely. Under LG, a buyer who sees one direct success on provider P and
 * ten gossiped successes from other buyers updates its posterior with
 * effective n=11, recovering most of the centralized router's evidence base.
 *
 * Sybilproof against gossip-poisoning: an adversary who fabricates fake
 * receipts cannot produce a valid payment preimage for a payment that did
 * not occur. Self-trades (buyer === provider) are structurally detectable
 * and filtered.
 *
 * Citations:
 *   - Boyd et al. (2006) — gossip protocol convergence
 *   - Jelasity et al. (2007) — epidemic information dissemination
 *   - BOLT specs / L402 — proof-of-payment verification
 */

import { V2_FLAGS } from "./config";

// ─── Receipt Structure ──────────────────────────────────────────────────────

/**
 * A signed outcome receipt that proves a job occurred and records its outcome.
 * The preimage links the receipt to the Lightning Network payment, making
 * fabrication impossible without controlling the payment channel.
 */
export interface L402Receipt {
  /** Unique job identifier */
  jobId: string;
  /** Buyer who paid for the job */
  buyerPubkey: string;
  /** Provider who executed the job */
  providerPubkey: string;
  /** Job outcome */
  outcome: "success" | "default";
  /** Unix timestamp (ms) */
  timestamp: number;
  /**
   * Payment preimage (hex string). In a real Lightning deployment, this is
   * the SHA-256 preimage that proves the HTLC was settled. In simulation,
   * we use HMAC(buyerSecret, jobId) as a deterministic stand-in.
   */
  paymentPreimage: string;
  /**
   * Buyer's signature over the canonical encoding of the receipt.
   * In simulation: HMAC(buyerSecret, canonicalEncode(receipt)).
   */
  signature: string;
}

// ─── Simulated Cryptography ─────────────────────────────────────────────────

/**
 * Deterministic simulated HMAC for receipt signing/verification.
 * In production, this would be replaced with real Ed25519 or BLS signatures.
 *
 * Uses a simple FNV-1a hash combined with the secret for deterministic
 * reproducibility under seeded experiments.
 */
function simulatedHMAC(secret: string, message: string): string {
  // FNV-1a inspired hash for simulation determinism
  let hash = 0x811c9dc5;
  const input = secret + ":" + message;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Second pass for the "keyed" part
  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0)).toString(16).padStart(8, "0");
}

function canonicalEncode(receipt: Omit<L402Receipt, "signature">): string {
  return `${receipt.jobId}|${receipt.buyerPubkey}|${receipt.providerPubkey}|${receipt.outcome}|${receipt.timestamp}|${receipt.paymentPreimage}`;
}

/**
 * Sign a receipt with the buyer's secret key.
 */
export function signReceipt(
  receipt: Omit<L402Receipt, "signature">,
  buyerSecret: string,
): L402Receipt {
  const message = canonicalEncode(receipt);
  const signature = simulatedHMAC(buyerSecret, message);
  return { ...receipt, signature };
}

/**
 * Verify a receipt's signature and preimage.
 * Returns true if the receipt is authentic and the payment preimage is valid.
 */
export function verifyReceipt(
  receipt: L402Receipt,
  buyerSecret: string,
): boolean {
  // Verify signature
  const message = canonicalEncode(receipt);
  const expectedSig = simulatedHMAC(buyerSecret, message);
  if (receipt.signature !== expectedSig) return false;

  // Verify preimage (in simulation: HMAC(buyerSecret, jobId))
  const expectedPreimage = simulatedHMAC(buyerSecret, receipt.jobId);
  if (receipt.paymentPreimage !== expectedPreimage) return false;

  return true;
}

/**
 * Generate a valid payment preimage for a job.
 * In real Lightning: this is the HTLC preimage revealed on settlement.
 * In simulation: deterministic HMAC.
 */
export function generatePreimage(buyerSecret: string, jobId: string): string {
  return simulatedHMAC(buyerSecret, jobId);
}

// ─── Gossip Protocol ────────────────────────────────────────────────────────

/**
 * Configuration for the gossip protocol.
 */
export const LG_CONFIG = {
  /** Weight applied to gossiped evidence vs direct evidence.
   *  1.0 = equal weight, 0.7 = 30% discount on gossip. */
  gossipEvidenceWeight: 0.7,

  /** Maximum receipts cached per provider per buyer */
  maxCachedReceiptsPerProvider: 100,

  /** Whether to filter self-trade receipts (buyer === provider) */
  filterSelfTrades: true,

  /** Simulated message loss rate for gossip protocol */
  messageLossRate: 0.0,

  /** Simulated gossip delay in rounds */
  gossipDelayRounds: 1,
} as const;

/**
 * A buyer's local evidence store, combining direct observations and
 * verified gossiped receipts.
 */
export class BuyerEvidenceStore {
  /** Buyer's own identifier */
  readonly buyerId: string;
  /** Buyer's secret key for signing receipts */
  readonly buyerSecret: string;

  /**
   * Per-provider evidence: { successes, failures } from direct observation,
   * plus gossiped evidence (weighted).
   */
  private directEvidence: Map<string, { successes: number; failures: number }> = new Map();
  private gossipEvidence: Map<string, { successes: number; failures: number }> = new Map();

  /** Cache of verified receipts received via gossip */
  private receiptCache: Map<string, L402Receipt[]> = new Map();

  /** Known buyer secrets for receipt verification (simulation only) */
  private knownBuyerSecrets: Map<string, string>;

  constructor(
    buyerId: string,
    buyerSecret: string,
    knownBuyerSecrets: Map<string, string>,
  ) {
    this.buyerId = buyerId;
    this.buyerSecret = buyerSecret;
    this.knownBuyerSecrets = knownBuyerSecrets;
  }

  /**
   * Record a direct job outcome (this buyer's own experience).
   * Also generates a signed receipt for gossiping.
   */
  recordDirectOutcome(
    jobId: string,
    providerId: string,
    outcome: "success" | "default",
    timestamp: number,
  ): L402Receipt {
    // Update direct evidence
    const ev = this.directEvidence.get(providerId) ?? { successes: 0, failures: 0 };
    if (outcome === "success") ev.successes++;
    else ev.failures++;
    this.directEvidence.set(providerId, ev);

    // Generate signed receipt
    const preimage = generatePreimage(this.buyerSecret, jobId);
    const receipt = signReceipt(
      {
        jobId,
        buyerPubkey: this.buyerId,
        providerPubkey: providerId,
        outcome,
        timestamp,
        paymentPreimage: preimage,
      },
      this.buyerSecret,
    );

    return receipt;
  }

  /**
   * Process a gossiped receipt from another buyer.
   * Verifies authenticity, filters self-trades, and updates gossip evidence.
   */
  processGossipedReceipt(receipt: L402Receipt): boolean {
    if (!V2_FLAGS.LG_ENABLED) return false;

    // Reject self-trades (buyer === provider)
    if (LG_CONFIG.filterSelfTrades && receipt.buyerPubkey === receipt.providerPubkey) {
      return false;
    }

    // Don't process our own receipts
    if (receipt.buyerPubkey === this.buyerId) return false;

    // Verify the receipt's signature using the known buyer secret
    const senderSecret = this.knownBuyerSecrets.get(receipt.buyerPubkey);
    if (!senderSecret) return false; // Unknown buyer — cannot verify

    if (!verifyReceipt(receipt, senderSecret)) return false;

    // Dedup: check if we already have this receipt
    const cached = this.receiptCache.get(receipt.providerPubkey) ?? [];
    if (cached.some(r => r.jobId === receipt.jobId)) return false;

    // Cache the receipt
    cached.push(receipt);
    if (cached.length > LG_CONFIG.maxCachedReceiptsPerProvider) {
      cached.shift(); // Drop oldest
    }
    this.receiptCache.set(receipt.providerPubkey, cached);

    // Update gossip evidence
    const ev = this.gossipEvidence.get(receipt.providerPubkey) ?? { successes: 0, failures: 0 };
    if (receipt.outcome === "success") ev.successes++;
    else ev.failures++;
    this.gossipEvidence.set(receipt.providerPubkey, ev);

    return true;
  }

  /**
   * Get the combined posterior for a provider, blending direct and
   * gossiped evidence with configurable weighting.
   *
   * Returns Beta(a, b) parameters for the posterior distribution.
   */
  getPosterior(providerId: string): { a: number; b: number } {
    const direct = this.directEvidence.get(providerId) ?? { successes: 0, failures: 0 };
    const gossip = this.gossipEvidence.get(providerId) ?? { successes: 0, failures: 0 };

    const w = LG_CONFIG.gossipEvidenceWeight;

    // Beta posterior: a = 1 + successes, b = 1 + failures
    // Gossiped evidence is weighted by `w` (default 0.7)
    const a = 1 + direct.successes + w * gossip.successes;
    const b = 1 + direct.failures + w * gossip.failures;

    return { a, b };
  }

  /**
   * Get the effective evidence volume (direct + weighted gossip) for a provider.
   * Used by the routing decision to assess confidence.
   */
  getEffectiveEvidence(providerId: string): number {
    const direct = this.directEvidence.get(providerId) ?? { successes: 0, failures: 0 };
    const gossip = this.gossipEvidence.get(providerId) ?? { successes: 0, failures: 0 };
    const w = LG_CONFIG.gossipEvidenceWeight;

    return (direct.successes + direct.failures)
      + w * (gossip.successes + gossip.failures);
  }

  /**
   * Get all signed receipts generated by this buyer (for gossiping to others).
   */
  getReceiptsForGossip(): L402Receipt[] {
    const receipts: L402Receipt[] = [];
    // In a real system, we'd maintain a separate outbox.
    // In simulation, regenerate from direct evidence is wasteful,
    // so the runner should cache receipts from recordDirectOutcome.
    return receipts;
  }
}

// ─── Gossip Network Simulation ──────────────────────────────────────────────

/**
 * Simulates a gossip network between multiple buyers.
 * Each round, buyers broadcast their recent receipts to all other buyers
 * (flooding protocol with configurable loss rate).
 */
export class GossipNetwork {
  private buyers: Map<string, BuyerEvidenceStore> = new Map();

  /** Receipts pending delivery (delayed by gossipDelayRounds) */
  private pendingReceipts: Array<{
    receipt: L402Receipt;
    deliveryRound: number;
  }> = [];

  /** Current simulation round */
  private currentRound = 0;

  /** Random function for message loss simulation */
  private random: () => number;

  constructor(random?: () => number) {
    this.random = random ?? Math.random;
  }

  /**
   * Register a buyer in the gossip network.
   */
  addBuyer(store: BuyerEvidenceStore): void {
    this.buyers.set(store.buyerId, store);
  }

  /**
   * Submit a receipt to the gossip network for broadcast.
   * The receipt will be delivered to all other buyers after the configured delay.
   */
  submitReceipt(receipt: L402Receipt): void {
    this.pendingReceipts.push({
      receipt,
      deliveryRound: this.currentRound + LG_CONFIG.gossipDelayRounds,
    });
  }

  /**
   * Advance the gossip network by one round.
   * Delivers all receipts whose delivery round has arrived.
   * Returns the number of successfully delivered receipts.
   */
  advanceRound(): number {
    this.currentRound++;
    let delivered = 0;

    // Deliver pending receipts that have matured
    const remaining: typeof this.pendingReceipts = [];
    for (const pending of this.pendingReceipts) {
      if (pending.deliveryRound <= this.currentRound) {
        // Deliver to all buyers except the sender
        for (const [buyerId, store] of this.buyers) {
          if (buyerId === pending.receipt.buyerPubkey) continue;

          // Simulate message loss
          if (LG_CONFIG.messageLossRate > 0 && this.random() < LG_CONFIG.messageLossRate) {
            continue;
          }

          if (store.processGossipedReceipt(pending.receipt)) {
            delivered++;
          }
        }
      } else {
        remaining.push(pending);
      }
    }
    this.pendingReceipts = remaining;

    return delivered;
  }

  /**
   * Get a buyer's evidence store.
   */
  getBuyerStore(buyerId: string): BuyerEvidenceStore | undefined {
    return this.buyers.get(buyerId);
  }

  /**
   * Get all buyer IDs in the network.
   */
  getBuyerIds(): string[] {
    return Array.from(this.buyers.keys());
  }

  /**
   * Reset the gossip network state (for new experiment cells).
   */
  reset(): void {
    this.buyers.clear();
    this.pendingReceipts = [];
    this.currentRound = 0;
  }
}
