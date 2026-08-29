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

import { join, dirname } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/** Resolve the sidecar directory for park state files. */
export function stateDirPath(stateDir) {
  return stateDir && stateDir.length > 0 ? stateDir : join(resolveDshHome(), 'peak-shift');
}

/** Resolve the sidecar file path for one session. */
export function stateFilePath(sessionId, stateDir) {
  return join(stateDirPath(stateDir), `${sessionId}.json`);
}

/**
 * Seed per-agent cumulative totals from every sidecar in the state dir, so
 * the settings-served aggregate survives process restarts even for sessions
 * that never return. File names are `<agentId>.json`; unreadable or foreign
 * files are skipped (fail-safe).
 * @returns {Map<string, {shifted: number, saved: number}>}
 */
export function loadPersistedTotals(stateDir) {
  const dir = stateDirPath(stateDir);
  const out = new Map();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name);
    if (m === null) continue;
    const saved = readStateFile(join(dir, name));
    if (!saved || saved.version !== 1 || !saved.stats) continue;
    out.set(m[1], {
      shifted: Number(saved.stats.shiftedRequests) || 0,
      saved: Number(saved.stats.savedEstimate) || 0,
    });
  }
  return out;
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
