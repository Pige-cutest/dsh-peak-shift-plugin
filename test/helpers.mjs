/** Tiny synchronous assertion runner shared by the test files. */

export function suite(name) {
  const cases = [];
  return {
    test(desc, fn) {
      cases.push({ desc, fn });
    },
    async run() {
      let pass = 0;
      const failures = [];
      for (const { desc, fn } of cases) {
        try {
          await fn();
          pass += 1;
        } catch (error) {
          failures.push({ name, desc, error });
        }
      }
      return { name, pass, total: cases.length, failures };
    },
  };
}

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

export function assertNear(actual, expected, epsilon = 1e-9, msg = '') {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) throw new Error(`${msg} expected number near ${expected}, got ${String(actual)}`);
  if (Math.abs(actual - expected) > epsilon) throw new Error(`${msg} expected ${expected} ± ${epsilon}, got ${actual}`);
}

export function assertUndefined(actual, msg = '') {
  if (actual !== undefined) throw new Error(`${msg} expected undefined, got ${String(actual)}`);
}
