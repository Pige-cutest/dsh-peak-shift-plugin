import { computeSavings, createStatsTracker, createTotals } from '../lib/stats.js';
import { suite, assert, assertNear } from './helpers.mjs';

const s = suite('stats');

const PRICING = {
  currency: 'USD',
  perMillion: { input: 0.27, cacheRead: 0.07, cacheWrite: 1.07, output: 1.1 },
  peakFactor: 1,
  offPeakFactor: 0.5,
};

s.test('computeSavings applies the per-million table and the peak/off-peak delta', () => {
  const usage = { inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 100000 };
  // base = (1e6*0.27 + 5e5*1.1 + 1e5*0.07)/1e6 = 0.827
  // saved = 0.827 * (1 - 0.5)
  assertNear(computeSavings(usage, PRICING), 0.4135, 1e-9, 'saved amount');
});

s.test('computeSavings ignores missing/empty usage', () => {
  assert(computeSavings(undefined, PRICING) === 0, 'undefined usage -> 0');
  assert(computeSavings({}, PRICING) === 0, 'empty usage -> 0');
  assert(computeSavings({ inputTokens: 0, outputTokens: 0 }, PRICING) === 0, 'zero tokens -> 0');
});

s.test('defer-mode tracker attributes usage at the recorded turn/step', () => {
  const tracker = createStatsTracker(PRICING);
  tracker.noteDeferred(1, 2);
  tracker.ingest([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 2, usage: { inputTokens: 1000000, outputTokens: 0 } } },
  ]);
  assert(tracker.totals.shiftedRequests === 1, 'one shifted request counted');
  assertNear(tracker.totals.savedEstimate, 0.135, 1e-9, 'saved = 0.27*0.5');
});

s.test('defer marker is consumed once', () => {
  const tracker = createStatsTracker(PRICING);
  tracker.noteDeferred(2, 1);
  tracker.ingest([{ type: 'assistant/message', data: { turn: 2, step: 1, usage: { outputTokens: 100000 } } }]);
  tracker.ingest([{ type: 'assistant/message', data: { turn: 2, step: 1, usage: { outputTokens: 100000 } } }]);
  assert(tracker.totals.shiftedRequests === 1, 'marker is one-shot');
});

s.test('park-mode tracker attributes via the resumed message id', () => {
  const tracker = createStatsTracker(PRICING);
  const msgId = 'm-held';
  tracker.noteParked([msgId]);
  tracker.ingest([
    { type: 'user/message', data: { id: msgId, turn: 3 } },
    { type: 'assistant/message', data: { turn: 3, step: 1, usage: { inputTokens: 2000000, outputTokens: 100000 } } },
  ]);
  assert(tracker.totals.shiftedRequests === 1, 'parked request counted');
  // base = (2e6*0.27 + 1e5*1.1)/1e6 = 0.65; saved = 0.325
  assertNear(tracker.totals.savedEstimate, 0.325, 1e-9, 'parked savings');
});

s.test('ingest is incremental (cursor advances)', () => {
  const tracker = createStatsTracker(PRICING);
  tracker.noteDeferred(1, 1);
  const events = [{ type: 'assistant/message', data: { turn: 1, step: 1, usage: { outputTokens: 1000000 } } }];
  tracker.ingest(events.slice(0, 1));
  tracker.ingest(events); // replaying the same array must not double-count
  assert(tracker.totals.shiftedRequests === 1, 'no double count on re-ingest');
});

s.test('createTotals starts at zero', () => {
  const t = createTotals();
  assert(t.shiftedRequests === 0 && t.savedEstimate === 0, 'zero totals');
});

export const run = () => s.run();
