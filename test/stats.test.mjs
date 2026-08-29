import { computeSavings, createStatsTracker, createTotals, DEEPSEEK_PRICING, effectivePerMillion } from '../lib/stats.js';
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

s.test('official DeepSeek price table: flash preset bills CNY peak prices with half-price off-peak', () => {
  // https://api-docs.deepseek.com/zh-cn/quick_start/pricing — v4-flash:
  // 命中 0.10 / 未命中 3.0 / 输出 9.0 (CNY per million, peak);空闲五折。
  const pricing = { ...DEEPSEEK_PRICING.flash, model: 'flash', peakFactor: 1, offPeakFactor: 0.5 };
  assert(effectivePerMillion(pricing).input === 3.0, 'cache-miss input price');
  assert(effectivePerMillion(pricing).cacheRead === 0.1, 'cache-hit input price');
  assert(effectivePerMillion(pricing).output === 9.0, 'output price');
  assert(effectivePerMillion(pricing).cacheWrite === 0, 'no separate cache-write category');
  // 1M uncached input at peak costs 3.0 CNY; shifting it off-peak saves half.
  assertNear(computeSavings({ inputTokens: 1000000 }, pricing), 1.5, 1e-9, 'saved CNY for 1M uncached input');
  // 1M cache hit: 0.10 peak -> 0.05 saved.
  assertNear(computeSavings({ cacheReadTokens: 1000000 }, pricing), 0.05, 1e-9, 'saved CNY for 1M cache hit');
  // 1M output: 9.0 peak -> 4.5 saved.
  assertNear(computeSavings({ outputTokens: 1000000 }, pricing), 4.5, 1e-9, 'saved CNY for 1M output');
});

s.test('official price table: pro preset', () => {
  const pricing = { ...DEEPSEEK_PRICING.pro, model: 'pro', peakFactor: 1, offPeakFactor: 0.5 };
  assert(effectivePerMillion(pricing).input === 9.0, 'pro cache-miss input');
  assert(effectivePerMillion(pricing).cacheRead === 0.3, 'pro cache hit');
  assert(effectivePerMillion(pricing).output === 27.0, 'pro output');
  assertNear(computeSavings({ inputTokens: 1000000 }, pricing), 4.5, 1e-9, 'saved CNY for 1M uncached input');
});

s.test('custom model uses the configured table verbatim', () => {
  const pricing = { ...PRICING, model: 'custom' };
  assert(effectivePerMillion(pricing) === pricing.perMillion, 'custom table passed through');
  assertNear(computeSavings({ inputTokens: 1000000 }, pricing), 0.135, 1e-9, 'custom-table savings');
});

s.test('unknown model falls back to the configured table', () => {
  assert(effectivePerMillion(PRICING) === PRICING.perMillion, 'no model -> configured table');
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
