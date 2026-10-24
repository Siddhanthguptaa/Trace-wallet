// Hypnexis stub (listed in patches.json). Missing from the public Trace_CIKM tree.
// The original writes a dashboard EventLog row. traceRouter only calls it for logging
// (and with experimentId set it is skipped); no simulation code reads EventLog, so a
// no-op cannot change routing, outcomes or metrics.
export type EventType =
  | "route"
  | "payment"
  | "payout"
  | "execution"
  | "completion"
  | "human_task"
  | "bounty"
  | "error"
  | "orchestrator";

export async function logEvent(
  _type: EventType | string,
  _message: string,
  _data: Record<string, unknown> = {},
): Promise<void> {
  // no-op
}
