/**
 * @module dsh-peak-shift/state
 * Sidecar persistence for park-mode held messages and cumulative stats.
 *
 * Out-of-repo plugins cannot append custom event types to the session log
 * (the resume path refuses unknown non-ignorable event types), so durable
 * pause state lives in an atomically-written JSON sidecar under
 * `$DSH_HOME/peak-shift/<sessionId>.json`. Goal pause/resume itself is
 * durable through `dsh-goal`'s own `goal/change` session events.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/** Resolve the sidecar file path for one session. */
export function stateFilePath(sessionId, stateDir) {
  const dir = stateDir && stateDir.length > 0 ? stateDir : join(resolveDshHome(), 'peak-shift');
  return join(dir, `${sessionId}.json`);
}

/** Read and parse a sidecar file; `null` when absent or corrupt. */
export function readStateFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomically replace a sidecar file (creates parent directories, 0600). */
export function writeStateFile(file, state) {
  return writeFileAtomic(file, JSON.stringify(state, null, 2), { mode: 0o600, dirMode: 0o700 });
}
