/**
 * CUSUM change-point detectors.
 *
 * `updateCUSUMScore` / `updateCUSUMSensitive` are ported verbatim (read-only) from TRACE's default-risk
 * component: sim/src/lib/trace/traceScore.ts (Framework 6 / 6b), identical to the attestor's port in
 * services/attestor/src/trace/port.ts. They run on a Bernoulli outcome stream (1 = success, 0 = failure):
 *   x_t = 1 - outcome,  S_t = max(0, S_{t-1} + x_t - (1 - K)),  alarm iff S_t > H.
 *
 * `pageCusum` is the same one-sided Page (1954) recursion with a real-valued observation and a free
 * reference value: S_t = max(0, S_{t-1} + x_t - k), alarm iff S_t > h. The watcher uses it on the binned
 * spend stream (see detectors.ts). Identity: updateCUSUMScore(S, o) == pageCusum(S, 1 - o, 1 - CUSUM_K, CUSUM_H)
 * up to TRACE's 4-decimal rounding.
 */

/** TRACE: reference value between honest (0.95) and adversarial (0.30) success means. */
export const CUSUM_K = 0.625;
/** TRACE: alarm threshold for a 5% false-alarm target, log(20) / KL ~ 4.2. */
export const CUSUM_H = 4.2;
/** TRACE dual CUSUM: tuned for a 5% -> 15% failure-rate shift. */
export const CUSUM_K_SENSITIVE = 0.9;
export const CUSUM_H_SENSITIVE = 2.5;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** fork: traceScore.ts#updateCUSUMScore (verbatim). */
export function updateCUSUMScore(current: number, outcome: 0 | 1): { newScore: number; alarm: boolean } {
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : 0;
  const x = outcome === 1 ? 0 : 1; // 1 for failure
  const newScore = Math.max(0, safeCurrent + x - (1 - CUSUM_K));
  return { newScore: round4(newScore), alarm: newScore > CUSUM_H };
}

/** fork: traceScore.ts#updateCUSUMSensitive (verbatim). */
export function updateCUSUMSensitive(current: number, outcome: 0 | 1): { newScore: number; alarm: boolean } {
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : 0;
  const x = outcome === 1 ? 0 : 1;
  const newScore = Math.max(0, safeCurrent + x - (1 - CUSUM_K_SENSITIVE));
  return { newScore: round4(newScore), alarm: newScore > CUSUM_H_SENSITIVE };
}

/** One-sided Page CUSUM step with a real-valued observation (no rounding). */
export function pageCusum(current: number, x: number, k: number, h: number): { newScore: number; alarm: boolean } {
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : 0;
  const safeX = Number.isFinite(x) ? x : 0;
  const newScore = Math.max(0, safeCurrent + safeX - k);
  return { newScore, alarm: newScore > h };
}
