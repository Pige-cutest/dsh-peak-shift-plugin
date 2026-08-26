import { createWindowPolicy, parseTimeRange } from '../lib/windows.js';
import { suite, assert, assertNear, assertUndefined } from './helpers.mjs';

const s = suite('windows');

/** Build an epoch ms for a local (Asia/Shanghai) calendar datetime string. */
function at(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  // CST is UTC+8; these are midday times so the UTC calendar date is unchanged.
  return Date.UTC(y, m - 1, d, hh - 8, mm);
}

const DEFAULT = {
  zone: 'Asia/Shanghai',
  peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: ['09:00-12:00', '14:00-18:00'] }],
};

s.test('isPeak: weekday mid-morning and mid-afternoon', () => {
  const p = createWindowPolicy(DEFAULT);
  assert(p.isPeak(at('2026-08-24', '09:30')) === true, 'Mon 09:30 CST should be peak');
  assert(p.isPeak(at('2026-08-24', '15:00')) === true, 'Mon 15:00 CST should be peak');
});

s.test('isPeak: boundaries are start-inclusive / end-exclusive', () => {
  const p = createWindowPolicy(DEFAULT);
  assert(p.isPeak(at('2026-08-24', '08:59')) === false, 'Mon 08:59 not peak');
  assert(p.isPeak(at('2026-08-24', '09:00')) === true, 'Mon 09:00 peak (start inclusive)');
  assert(p.isPeak(at('2026-08-24', '12:00')) === false, 'Mon 12:00 not peak (end exclusive)');
  assert(p.isPeak(at('2026-08-24', '14:00')) === true, 'Mon 14:00 peak (start inclusive)');
  assert(p.isPeak(at('2026-08-24', '18:00')) === false, 'Mon 18:00 not peak (end exclusive)');
});

s.test('isPeak: lunch gap and after hours are off-peak', () => {
  const p = createWindowPolicy(DEFAULT);
  assert(p.isPeak(at('2026-08-24', '12:30')) === false, 'Mon 12:30 lunch gap off-peak');
  assert(p.isPeak(at('2026-08-24', '18:30')) === false, 'Mon 18:30 off-peak');
  assert(p.isPeak(at('2026-08-24', '00:30')) === false, 'Mon 00:30 off-peak');
});

s.test('isPeak: weekends are always off-peak', () => {
  const p = createWindowPolicy(DEFAULT);
  assert(p.isPeak(at('2026-08-29', '10:00')) === false, 'Sat 10:00 off-peak');
  assert(p.isPeak(at('2026-08-30', '15:00')) === false, 'Sun 15:00 off-peak');
});

s.test('next transitions within a peak day', () => {
  const p = createWindowPolicy(DEFAULT);
  const offPeakAt = p.nextOffPeakAt(at('2026-08-24', '11:00'));
  assert(offPeakAt === at('2026-08-24', '12:00'), `next off-peak from 11:00 should be 12:00, got ${new Date(offPeakAt).toISOString()}`);
  const peakAt = p.nextPeakAt(at('2026-08-24', '13:00'));
  assert(peakAt === at('2026-08-24', '14:00'), `next peak from 13:00 should be 14:00, got ${new Date(peakAt).toISOString()}`);
});

s.test('msUntilOffPeak from mid-peak is the remainder of the range', () => {
  const p = createWindowPolicy(DEFAULT);
  assertNear(p.msUntilOffPeak(at('2026-08-24', '11:00')), 3600000, 1, '1h until 12:00');
  assertNear(p.msUntilOffPeak(at('2026-08-24', '16:30')), 5400000, 1, '90m until 18:00');
});

s.test('next peak rolls to the following weekday', () => {
  const p = createWindowPolicy(DEFAULT);
  const next = p.nextPeakAt(at('2026-08-24', '18:30'));
  assert(next === at('2026-08-25', '09:00'), `next peak after Mon 18:30 should be Tue 09:00, got ${next === undefined ? 'undefined' : new Date(next).toISOString()}`);
});

s.test('next off-peak after Friday evening rolls to the next week\'s first peak end (Mon 12:00)', () => {
  const p = createWindowPolicy(DEFAULT);
  const friday = p.nextOffPeakAt(at('2026-08-28', '18:30'));
  // Already off-peak; the next transition to off-peak is the end of the next
  // week's first peak (Mon 09:00-12:00), i.e. Monday 12:00.
  assert(friday === at('2026-08-31', '12:00'), `expected next off-peak at Mon 12:00, got ${friday === undefined ? 'undefined' : new Date(friday).toISOString()}`);
});

s.test('midnight-crossing range', () => {
  const p = createWindowPolicy({ zone: 'Asia/Shanghai', peak: [{ ranges: ['22:00-06:00'] }] });
  assert(p.isPeak(at('2026-08-24', '23:00')) === true, 'Mon 23:00 peak');
  assert(p.isPeak(at('2026-08-25', '05:00')) === true, 'Tue 05:00 peak');
  assert(p.isPeak(at('2026-08-25', '07:00')) === false, 'Tue 07:00 off-peak');
  const end = p.nextOffPeakAt(at('2026-08-24', '23:00'));
  assert(end === at('2026-08-25', '06:00'), `next off-peak from Mon 23:00 should be Tue 06:00, got ${end === undefined ? 'undefined' : new Date(end).toISOString()}`);
});

s.test('empty peak list means always off-peak', () => {
  const p = createWindowPolicy({ zone: 'Asia/Shanghai', peak: [] });
  assert(p.isPeak(Date.now()) === false, 'no peak ranges -> off-peak');
  assertUndefined(p.nextPeakAt(Date.now()), 'no next peak');
  assertUndefined(p.nextOffPeakAt(Date.now()), 'no next off-peak');
  assert(p.msUntilOffPeak(Date.now()) === Infinity, 'msUntilOffPeak is Infinity');
});

s.test('parseTimeRange rejects malformed input', () => {
  let threw = false;
  try { parseTimeRange('9:00-12:00'); } catch { threw = true; }
  assert(threw, 'single-digit hours rejected');
  threw = false;
  try { parseTimeRange('25:00-26:00'); } catch { threw = true; }
  assert(threw, 'out-of-range hours rejected');
});

s.test('weekday numbers and short names both work', () => {
  const p = createWindowPolicy({ zone: 'Asia/Shanghai', peak: [{ days: [1, 2], ranges: ['00:00-23:59'] }] });
  assert(p.isPeak(at('2026-08-24', '10:00')) === true, 'Mon (1) in [1,2] is peak');
  assert(p.isPeak(at('2026-08-25', '10:00')) === true, 'Tue (2) in [1,2] is peak');
  assert(p.isPeak(at('2026-08-26', '10:00')) === false, 'Wed (3) not in [1,2] is off-peak');
  const q = createWindowPolicy({ zone: 'Asia/Shanghai', peak: [{ days: ['mon'], ranges: ['00:00-23:59'] }] });
  assert(q.isPeak(at('2026-08-24', '10:00')) === true, 'Mon full-day peak');
  assert(q.isPeak(at('2026-08-25', '10:00')) === false, 'Tue not peak');
});

export const run = () => s.run();
