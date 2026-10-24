// Hypnexis stub (listed in patches.json). Missing from the public Trace_CIKM tree.
// runner.ts uses computeRecoveryMetric only to fill the post-hoc
// finalMetrics.recoveryRound diagnostic after the simulation loop ends. Fraud,
// routing and served-provider metrics never read it, so returning null is a no-op
// for every number this fork reports.
export interface RecoveryMetric {
  metricKey: string;
  baselineWindow: null;
  smoothedLiveSeries: number[];
  recoveryRound: number | null;
}

export function computeRecoveryMetric(
  _honestSeries: readonly number[],
  _liveSeries: readonly number[],
  _attackStartRound: number = 0,
  metricKey: string = "maliciousRoutingRate",
): RecoveryMetric {
  return { metricKey, baselineWindow: null, smoothedLiveSeries: [], recoveryRound: null };
}
