import { run as runWindows } from './windows.test.mjs';
import { run as runStats } from './stats.test.mjs';
import { run as runSmoke } from './smoke.test.mjs';

const runs = [runWindows, runStats, runSmoke];
const results = [];
for (const run of runs) results.push(await run());

let total = 0;
let passed = 0;
for (const result of results) {
  total += result.total;
  passed += result.pass;
  console.log(`  ${result.pass}/${result.total}  ${result.name}`);
  for (const failure of result.failures) {
    console.error(`\n✗ [${failure.name}] ${failure.desc}`);
    console.error(`  ${failure.error?.stack ?? failure.error}`);
  }
}

if (passed === total) {
  console.log(`\nAll ${total} tests passed.`);
  process.exit(0);
}
console.error(`\n${total - passed} of ${total} tests failed.`);
process.exit(1);
