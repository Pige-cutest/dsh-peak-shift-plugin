/**
 * @module dsh-peak-shift/windows
 * Weekly peak/off-peak window policy in an IANA time zone.
 *
 * A windows config is:
 *   { zone: 'Asia/Shanghai',
 *     peak: [{ days?: ['mon', ...], ranges: ['09:00-12:00', '14:00-18:00'] }] }
 *
 * - `days` absent or empty means every day of the week; otherwise a list of
 *   `mon`..`sun` or 0..6.
 * - Each range is `HH:MM-HH:MM`. An end no later than its start crosses
 *   midnight into the following local day (e.g. `22:00-06:00`).
 * - Off-peak is every instant not inside a peak range.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MINUTE_OF_DAY = 24 * 60;

/** Parse one `HH:MM-HH:MM` range into `{ start, end }` minute-of-day. */
export function parseTimeRange(text) {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(text).trim());
  if (m === null) throw new TypeError(`peak-shift: invalid time range ${JSON.stringify(text)} (expected HH:MM-HH:MM)`);
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start >= MINUTE_OF_DAY || end >= MINUTE_OF_DAY) throw new TypeError(`peak-shift: time range ${JSON.stringify(text)} is out of range`);
  return { start, end };
}

/** Normalize a weekday list to weekday indices (0=sun) or `null` for every day. */
function normalizeWeekdays(days) {
  if (!Array.isArray(days) || days.length === 0) return null;
  return days.map((d) => {
    if (typeof d === 'number') return ((d % 7) + 7) % 7;
    const key = String(d).toLowerCase();
    const idx = WEEKDAYS.indexOf(key);
    if (idx < 0) throw new TypeError(`peak-shift: unknown weekday ${JSON.stringify(d)} (expected mon..sun or 0..6)`);
    return idx;
  });
}

/** Local clock breakdown for `now` in `zone`. */
function zonedClock(now, zone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday, minuteOfDay: hour * 60 + minute };
}

/** UTC offset (ms) of `zone` at `epochMs`, via Intl longOffset. */
function zoneOffsetMs(zone, epochMs) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    const name = formatter.formatToParts(epochMs).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /^GMT([+-])(\d{2}):(\d{2})/.exec(name);
    if (m === null) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) * 1000;
  } catch {
    return 0;
  }
}

/** Convert a local calendar `(year, month, day, hour, minute)` in `zone` to epoch ms. */
function localToEpoch(zone, year, month, day, hour, minute) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const epoch = guess - zoneOffsetMs(zone, guess);
    const c = zonedClock(epoch, zone);
    if (c.year === year && c.month === month && c.day === day && c.hour === hour && c.minute === minute) return epoch;
    const diffMin = (c.day - day) * 1440 + (c.hour - hour) * 60 + (c.minute - minute);
    guess = epoch - diffMin * 60000;
  }
  return guess - zoneOffsetMs(zone, guess);
}

/**
 * Build a window policy from a windows config.
 * @param {object} config - `{ zone, peak: [{ days?, ranges }] }`.
 */
export function createWindowPolicy(config) {
  const zone = config.zone;
  const entries = (config.peak ?? []).map((entry) => ({
    weekdays: normalizeWeekdays(entry.days),
    ranges: (entry.ranges ?? []).map(parseTimeRange),
  }));

  /** Whether `minute` of day is inside `range` (midnight-crossing aware). */
  function inRange(minute, range) {
    if (range.end > range.start) return minute >= range.start && minute < range.end;
    return minute >= range.start || minute < range.end;
  }

  function isPeakAt(now) {
    const c = zonedClock(now, zone);
    for (const entry of entries) {
      if (entry.weekdays !== null && !entry.weekdays.includes(c.weekday)) continue;
      for (const range of entry.ranges) if (inRange(c.minuteOfDay, range)) return true;
    }
    return false;
  }

  /** Every range boundary for the next `days` local days, as candidate transitions. */
  function boundariesFrom(now, days = 9) {
    const start = zonedClock(now, zone);
    const out = [];
    for (let offset = 0; offset <= days; offset++) {
      const base = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
      const year = base.getUTCFullYear();
      const month = base.getUTCMonth() + 1;
      const day = base.getUTCDate();
      const weekday = base.getUTCDay();
      for (const entry of entries) {
        if (entry.weekdays !== null && !entry.weekdays.includes(weekday)) continue;
        for (const range of entry.ranges) {
          const crosses = range.end <= range.start;
          out.push({
            epoch: localToEpoch(zone, year, month, day, Math.floor(range.start / 60), range.start % 60),
            toPeak: true,
          });
          out.push({
            epoch: localToEpoch(zone, year, month, day + (crosses ? 1 : 0), Math.floor(range.end / 60), range.end % 60),
            toPeak: false,
          });
        }
      }
    }
    return out;
  }

  /**
   * Next transition instant strictly after `now`.
   * @param {number} now - epoch ms.
   * @param {boolean} wantPeak - true for the next peak start, false for the next peak end.
   * @returns {number|undefined} epoch ms, or undefined when the schedule has no peak ranges.
   */
  function nextTransition(now, wantPeak) {
    if (entries.length === 0) return undefined;
    let best = Infinity;
    for (const b of boundariesFrom(now)) {
      if (b.epoch > now && b.toPeak === wantPeak && b.epoch < best) best = b.epoch;
    }
    return Number.isFinite(best) ? best : undefined;
  }

  function msUntil(now, wantPeak) {
    const target = nextTransition(now, wantPeak);
    return target === undefined ? Infinity : Math.max(0, target - now);
  }

  return {
    zone,
    isPeak(now) { return isPeakAt(now); },
    nextPeakAt(now) { return nextTransition(now, true); },
    nextOffPeakAt(now) { return nextTransition(now, false); },
    msUntilPeak(now) { return msUntil(now, true); },
    msUntilOffPeak(now) { return msUntil(now, false); },
    describe(now) {
      return {
        window: isPeakAt(now) ? 'peak' : 'off-peak',
        nextPeakAt: nextTransition(now, true),
        nextOffPeakAt: nextTransition(now, false),
      };
    },
  };
}
