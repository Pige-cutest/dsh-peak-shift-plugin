/**
 * @module dsh-peak-shift/stats
 * Token-cost savings estimation.
 *
 * The harness records token usage but no money: `assistant/message.usage`
 * carries `TokenUsage { inputTokens, outputTokens, cacheReadTokens?,
 * cacheWriteTokens? }`. This module applies the configured per-million price
 * table and peak/off-peak factors to estimate how much shifting a step from
 * peak to off-peak saved. It is an ESTIMATE for reporting, not a bill.
 */

/**
 * Money saved by running one step off-peak instead of on-peak.
 * @param {object|undefined} usage - provider-reported `TokenUsage`, or undefined.
 * @param {object} pricing - `{ perMillion: {input, cacheRead, cacheWrite, output}, peakFactor, offPeakFactor }`.
 * @returns {number} estimated saved amount in the configured currency.
 */
export function computeSavings(usage, pricing) {
  if (!usage) return 0;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (input + output + cacheRead + cacheWrite <= 0) return 0;
  const base =
    (input * pricing.perMillion.input +
      output * pricing.perMillion.output +
      cacheRead * pricing.perMillion.cacheRead +
      cacheWrite * pricing.perMillion.cacheWrite) /
    1e6;
  return base * Math.max(0, pricing.peakFactor - pricing.offPeakFactor);
}

/** Fresh cumulative savings counters. */
export function createTotals() {
  return { shiftedRequests: 0, savedEstimate: 0 };
}

/**
 * Incremental fold of a session log into savings.
 *
 * The gate calls `noteDeferred` (defer mode) or `noteParked` (park mode) when
 * it shifts a step; `ingest` then attributes the step's real `usage` once it
 * runs at off-peak. Cursor-based, so repeated `ingest` calls are cheap.
 *
 * Matching rules:
 * - defer: an `assistant/message` at the recorded `turn/step`.
 * - park: a `user/message` whose id was parked marks its turn; the next
 *   `assistant/message` in that turn is the shifted one.
 */
export function createStatsTracker(pricing) {
  const deferredSteps = new Set();
  const parkedIds = new Set();
  let parkedTurn = null;
  let cursor = 0;
  const totals = createTotals();

  function addSaved(usage) {
    totals.shiftedRequests += 1;
    totals.savedEstimate += computeSavings(usage, pricing);
  }

  return {
    /** Record a step that was held until off-peak (defer mode). */
    noteDeferred(turn, step) { deferredSteps.add(`${turn}/${step}`); },
    /** Record messages that were parked (park mode). */
    noteParked(messageIds) { for (const id of messageIds) parkedIds.add(id); },
    /** Fold any new events from a session log into the totals. */
    ingest(events) {
      for (let i = cursor; i < events.length; i++) {
        const event = events[i];
        switch (event.type) {
          case 'assistant/message': {
            const key = `${event.data.turn}/${event.data.step}`;
            if (deferredSteps.delete(key)) addSaved(event.data.usage);
            if (parkedTurn !== null && event.data.turn === parkedTurn) {
              parkedTurn = null;
              addSaved(event.data.usage);
            }
            break;
          }
          case 'user/message': {
            const id = event.data.id;
            if (parkedIds.delete(id)) parkedTurn = event.data.turn;
            break;
          }
          default: break;
        }
      }
      cursor = events.length;
    },
    get totals() { return totals; },
  };
}
