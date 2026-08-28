/**
 * @module dsh-peak-shift
 * Pause long-running dsh agents during DeepSeek peak-priced hours and resume
 * them at off-peak, saving token costs.
 *
 * Default window rule (DeepSeek billing): peak = Beijing time Mon–Fri
 * 09:00–12:00 and 14:00–18:00; everything else (including weekends) is the
 * off-peak half-price window.
 *
 * The plugin is dual-face: this Node half owns the gate; `lib/client.js` is
 * the browser half (a `dsh.client` web bundle) that registers the Plugins
 * settings card. The two halves meet in the `peak-shift` settings namespace:
 * the card edits the user layer, this half rebuilds the live window policy on
 * every commit, and the `stats` block on the namespace `base` carries the
 * live savings snapshot (the settings provider clones `base` on every
 * describe read, so in-place updates reach the browser).
 */

import z from '@deepseek-ai/schemastery';
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import { createWindowPolicy } from './windows.js';
import { PeakShiftRuntime } from './runtime.js';
import { registerPeakShiftTools } from './tools.js';
import { registerPeakShiftCommand } from './command.js';

/** Cordis function-plugin name used by loader diagnostics. */
export const name = 'peak-shift';
/** Services required before this plugin loads. `goals`/`settings`/`commands` stay optional. */
export const inject = ['agents', 'sessions', 'tools', 'timer'];

const DEFAULT_WINDOWS = {
  zone: 'Asia/Shanghai',
  peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: ['09:00-12:00', '14:00-18:00'] }],
};

/**
 * The hot-reloaded user-settings namespace: `$DSH_HOME/settings.yaml` section
 * `peak-shift` is the single shared backend for the `/peak-shift` command, the
 * model tools, and the web settings card.
 *
 * The window fields are a flat, UI-editable projection of `config.windows`
 * (first peak entry's first two ranges plus its weekday list); saving any of
 * them from the card rebuilds the live policy from the flat shape.
 */
export const SETTINGS_NAMESPACE = 'peak-shift';
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  leadMinutes: z.number().min(0).default(5),
  days: z.array(z.string()).default(DEFAULT_WINDOWS.peak[0].days),
  morning: z.string().default(DEFAULT_WINDOWS.peak[0].ranges[0]),
  afternoon: z.string().default(DEFAULT_WINDOWS.peak[0].ranges[1]),
});

/** Empty savings snapshot; the live object lives on the settings `base`. */
function freshStats(currency) {
  return {
    shiftedRequests: 0,
    savedEstimate: 0,
    currency,
    window: 'off-peak',
    nextPeakAt: '',
    nextOffPeakAt: '',
    updatedAt: 0,
  };
}

/**
 * Seed the namespace `base` from the composed config. This object is passed
 * to {@link installSettingsSection} as the base layer and kept for the whole
 * plugin lifetime: `refreshStats` replaces `base.stats` in place so every
 * later settings describe read carries current numbers.
 */
function deriveSettingsBase(config) {
  const entry = config.windows.peak[0] ?? {};
  const ranges = entry.ranges ?? [];
  return {
    enabled: config.enabled !== false,
    leadMinutes: config.leadMinutes,
    days: [...(entry.days ?? [])],
    morning: ranges[0] ?? '',
    afternoon: ranges[1] ?? '',
    stats: freshStats(config.pricing.currency),
  };
}

/** Schemastery validation for {@link Config}. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  targets: z.array(z.union([
    z.const('goal'),
    z.const('headless'),
    z.const('subagent'),
    z.const('interactive'),
  ])).default(['goal']),
  windows: z.object({
    zone: z.string().default(DEFAULT_WINDOWS.zone),
    peak: z.array(z.object({
      days: z.array(z.string()).default([]),
      ranges: z.array(z.string()).default([]),
    })).default(DEFAULT_WINDOWS.peak),
  }).default(DEFAULT_WINDOWS),
  leadMinutes: z.number().min(0).default(5),
  enforcement: z.union([z.const('gate'), z.const('cancel')]).default('gate'),
  mode: z.union([z.const('park'), z.const('defer'), z.const('off')]).default('park'),
  pricing: z.object({
    currency: z.string().default('USD'),
    perMillion: z.object({
      input: z.number().default(0.27),
      cacheRead: z.number().default(0.07),
      cacheWrite: z.number().default(1.07),
      output: z.number().default(1.1),
    }).default({}),
    peakFactor: z.number().default(1),
    offPeakFactor: z.number().default(0.5),
  }).default({}),
  startPolicy: z.union([z.const('park'), z.const('run')]).default('park'),
  pollIntervalMs: z.number().min(1000).default(30000),
  stateDir: z.string().default(''),
});

/** Install peak-shift for agents published after this plugin loads. */
export function apply(ctx, config) {
  let policy = createWindowPolicy(config.windows);
  const goals = optionalService(ctx, 'goals');
  const headless = optionalService(ctx, 'headlessStartup') !== undefined;
  const runtimes = new Map();

  // ── master switch + window overrides (settings-backed, hot-reloaded) ─────
  // `state.enabled` is the single source of truth for whether peak-shift acts
  // at all. It is seeded from the composition config and updated live from
  // the `$DSH_HOME/settings.yaml` section `peak-shift` via the settings
  // namespace below; `/peak-shift`, the peak_shift_* tools, the web settings
  // card, and direct settings.yaml edits all converge here.
  const settingsBase = deriveSettingsBase(config);
  const state = { enabled: settingsBase.enabled };
  let settingsSource = () => settingsBase;
  const controller = {
    isEnabled: () => state.enabled,
    async setEnabled(value) {
      state.enabled = value !== false;
      await applyEnabledState();
      const settings = optionalService(ctx, 'settings');
      if (settings && settings.writable) {
        try {
          await settings.update(SETTINGS_NAMESPACE, { enabled: state.enabled });
        } catch (error) {
          ctx.logger.warn(`peak-shift: could not persist settings toggle: ${error?.message ?? String(error)}`);
        }
      }
    },
  };

  /** When the master switch turns off, never strand a paused task. */
  async function applyEnabledState() {
    if (state.enabled) return;
    await Promise.allSettled([...runtimes.values()].map(async ({ runtime }) => {
      if (runtime.isPaused() && runtime.override !== 'force-paused') {
        await runtime.enterOffPeak().catch((error) => {
          ctx.logger.warn(`peak-shift: resume on disable failed for ${runtime.agent.id}: ${error?.message ?? String(error)}`);
        });
      }
    }));
  }

  /**
   * Rebuild the live window policy from the resolved settings section. The
   * flat fields (days + up to two ranges) replace `config.windows`; an
   * invalid shape is ignored with a warning so the previous policy keeps
   * gating (fail-safe — the settings UI can never wedge the gate).
   */
  function rebuildWindows(resolved) {
    const lead = Number.isFinite(resolved.leadMinutes) && resolved.leadMinutes >= 0
      ? resolved.leadMinutes
      : config.leadMinutes;
    const ranges = [resolved.morning, resolved.afternoon]
      .map((range) => String(range ?? '').trim())
      .filter((range) => range !== '');
    const days = Array.isArray(resolved.days) ? resolved.days.map(String) : [];
    try {
      const windows = { zone: config.windows.zone, peak: [{ days, ranges }] };
      const nextPolicy = createWindowPolicy(windows); // throws on bad ranges/weekdays
      config.windows = windows;
      config.leadMinutes = lead;
      policy = nextPolicy;
      for (const { runtime } of runtimes.values()) runtime.policy = nextPolicy;
    } catch (error) {
      ctx.logger.warn(`peak-shift: ignoring invalid window settings (${error?.message ?? String(error)})`);
    }
  }

  function onSettingsChange() {
    const resolved = settingsSource() ?? settingsBase;
    state.enabled = resolved.enabled !== false;
    rebuildWindows(resolved);
  }

  // ── live stats on the settings base ────────────────────────────────────────
  // Per-agent last-known totals: a disposed agent keeps its contribution
  // visible, and a recreated session (sidecar-restored totals) overwrites its
  // own row instead of double-counting. Cleared naturally on process restart.
  const lastTotals = new Map();

  /** Publish the aggregate savings snapshot onto the settings `base`. */
  function refreshStats() {
    for (const { runtime } of runtimes.values()) {
      lastTotals.set(runtime.agent.id, {
        shifted: runtime.stats.totals.shiftedRequests,
        saved: runtime.stats.totals.savedEstimate,
      });
    }
    let shiftedRequests = 0;
    let savedEstimate = 0;
    for (const entry of lastTotals.values()) {
      shiftedRequests += entry.shifted;
      savedEstimate += entry.saved;
    }
    const desc = policy.describe(Date.now());
    settingsBase.stats = {
      shiftedRequests,
      savedEstimate: Math.round(savedEstimate * 100) / 100,
      currency: config.pricing.currency,
      window: desc.window,
      nextPeakAt: desc.nextPeakAt === undefined ? '' : new Date(desc.nextPeakAt).toISOString(),
      nextOffPeakAt: desc.nextOffPeakAt === undefined ? '' : new Date(desc.nextOffPeakAt).toISOString(),
      updatedAt: Date.now(),
    };
  }

  installSettingsSection(ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, settingsBase, {
    setSource(thunk) { settingsSource = thunk; },
    onChange: onSettingsChange,
  });

  registerPeakShiftCommand(ctx, controller);

  ctx.on('agent/created', ({ agent }) => {
    if (runtimes.has(agent)) return;
    // Fail-safe: any peak-shift setup error is contained and logged so agent
    // creation / publication is never broken by this plugin.
    let runtime;
    try {
      runtime = new PeakShiftRuntime(ctx, config, agent, goals, policy, { headless }, controller);
    } catch (error) {
      ctx.logger.warn(`peak-shift: could not create runtime for ${agent.id}: ${error?.message ?? String(error)}`);
      return;
    }
    let cleanup;
    try {
      cleanup = agent.ctx.effect(() => {
        const disposers = [];
        try {
          disposers.push(registerPeakShiftTools(ctx, agent, runtime));
          disposers.push(agent.ctx.on('agent/session-start', () => {
            runtime.onSessionStart();
          }));
          disposers.push(agent.ctx.on('agent/pre-step', (payload, next) => {
            return runtime.gate(payload, next);
          }, { prepend: true }));
        } catch (error) {
          ctx.logger.warn(`peak-shift: partial setup for ${agent.id}: ${error?.message ?? String(error)}`);
        }
        return () => {
          for (const dispose of [...disposers].reverse()) {
            try {
              dispose();
            } catch {
              /* already disposed */
            }
          }
          runtime.dispose();
        };
      }, 'peak-shift.runtime()');
    } catch (error) {
      ctx.logger.warn(`peak-shift: could not attach runtime for ${agent.id}: ${error?.message ?? String(error)}`);
      return;
    }
    // The map holds { runtime, cleanup }: the poll needs the runtime; disposal
    // needs the effect cleanup. Storing only the cleanup (as before) made
    // `poll()` call `runtime.isTarget` on a function and crash the web process
    // on the first interval tick once an agent existed.
    runtimes.set(agent, { runtime, cleanup });
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const entry = runtimes.get(agent);
    if (entry !== undefined) {
      runtimes.delete(agent);
      refreshStats();
      Promise.resolve(entry.cleanup()).catch(() => {});
    }
  });

  refreshStats();
  const stopPoll = ctx.interval(() => poll(), config.pollIntervalMs);
  function poll() {
    refreshStats();
    if (!controller.isEnabled()) return;
    const peak = policy.isPeak(Date.now() + config.leadMinutes * 60000);
    for (const { runtime } of runtimes.values()) {
      try {
        if (!runtime.isTarget()) continue;
        if (peak) {
          runtime._enterPause().catch((error) => {
            ctx.logger.warn(`peak-shift: pause failed for ${runtime.agent.id}: ${error?.message ?? String(error)}`);
          });
        } else if (runtime.isPaused() && runtime.override !== 'force-paused') {
          runtime.enterOffPeak().catch((error) => {
            ctx.logger.warn(`peak-shift: resume failed for ${runtime.agent.id}: ${error?.message ?? String(error)}`);
          });
        }
      } catch (error) {
        ctx.logger.warn(`peak-shift: poll failed for ${runtime.agent.id}: ${error?.message ?? String(error)}`);
      }
    }
  }

  ctx.effect(() => async () => {
    stopPoll();
    const entries = [...runtimes.values()];
    runtimes.clear();
    await Promise.allSettled(entries.map((entry) => Promise.resolve(entry.cleanup())));
  });
}

/** Read a service by name without failing when it is not provided. */
function optionalService(ctx, serviceName) {
  try {
    return ctx.get(serviceName);
  } catch {
    return undefined;
  }
}
