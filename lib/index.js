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
 * settings page. The two halves meet in the `peak-shift` settings namespace.
 *
 * ## Two settings generations
 *
 * dsh replaced its plugin-settings model, so this half installs whichever
 * control plane the running version provides (see `lib/compat.js`):
 *
 * - **Legacy (≤ 0.1.1-rc.2)** — `installSettingsSection` owns a section of
 *   `$DSH_HOME/settings.yaml`; the settings UI is a *flat* projection
 *   (`days` / `morning` / `afternoon` / `model`) and the live savings snapshot
 *   rides the section's `base` object.
 * - **Modern (≥ 0.1.7-rc.2, incl. 0.2.x)** — the plugin marks fields of its
 *   `Config` with `.volatile()`; the `settings` service projects them into a
 *   form keyed by the profile entry id, persists edits into the active
 *   profile's Cordis patch, and emits `settings/document-updated`. The form is
 *   *nested* (`windows.peak[]`, `pricing.model`).
 * - **Gap (0.1.2 – 0.1.6)** — neither API: the gate runs from the composition
 *   config and the settings UI is simply absent.
 *
 * Both generations write into one plain, mutable `live` view that the gate and
 * the per-agent runtimes read, so a single enforcement path serves all of them.
 */

import z from '@deepseek-ai/schemastery';
// Namespace import, never a named import: `installSettingsSection` is absent on
// modern dsh and a missing named export is an ESM link-time error.
import * as dshSettings from '@deepseek-ai/dsh-settings';
import { createWindowPolicy } from './windows.js';
import { PeakShiftRuntime } from './runtime.js';
import { registerPeakShiftTools } from './tools.js';
import { registerPeakShiftCommand } from './command.js';
import { loadPersistedTotals } from './state.js';
import {
  isModernSettings,
  optionalService,
  resolveNamespace,
  unwrapDeep,
  volatileField,
} from './compat.js';

/** Cordis function-plugin name used by loader diagnostics. */
export const name = 'peak-shift';
/** Services required before this plugin loads. `goals`/`settings`/`commands` stay optional. */
export const inject = ['agents', 'sessions', 'tools', 'timer'];

/** Legacy settings installer, present only on dsh ≤ 0.1.1-rc.2. */
const installSettingsSection = typeof dshSettings?.installSettingsSection === 'function'
  ? dshSettings.installSettingsSection
  : undefined;

const DEFAULT_WINDOWS = {
  zone: 'Asia/Shanghai',
  peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: ['09:00-12:00', '14:00-18:00'] }],
};

/**
 * The legacy hot-reloaded user-settings namespace: `$DSH_HOME/settings.yaml`
 * section `peak-shift` is the single shared backend for the `/peak-shift`
 * command, the model tools, and the web settings card.
 *
 * The window fields are a flat, UI-editable projection of `config.windows`
 * (first peak entry's first two ranges plus its weekday list); saving any of
 * them from the card rebuilds the live policy from the flat shape.
 *
 * On modern dsh this schema is unused — the `Config` volatile fields below are
 * the form instead.
 */
export const SETTINGS_NAMESPACE = 'peak-shift';
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  leadMinutes: z.number().min(0).default(5),
  days: z.array(z.string()).default(DEFAULT_WINDOWS.peak[0].days),
  morning: z.string().default(DEFAULT_WINDOWS.peak[0].ranges[0]),
  afternoon: z.string().default(DEFAULT_WINDOWS.peak[0].ranges[1]),
  // Which official price table the savings estimate bills against.
  model: z.union([z.const('flash'), z.const('pro'), z.const('custom')]).default('flash'),
  // Control channel from the web card: `resume:<agentId>` or `resume-all`.
  // The host executes a changed value once and clears the field again.
  commands: z.string().default(''),
});

/** Empty savings snapshot; the live object lives on the legacy settings `base`. */
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
 * Seed the legacy namespace `base` from the composed config. This object is
 * passed to `installSettingsSection` as the base layer and kept for the whole
 * plugin lifetime: `refreshStats` replaces `base.stats` in place so every
 * later settings describe read carries current numbers.
 */
function deriveSettingsBase(live) {
  const entry = live.windows.peak[0] ?? {};
  const ranges = entry.ranges ?? [];
  return {
    enabled: live.enabled !== false,
    leadMinutes: live.leadMinutes,
    days: [...(entry.days ?? [])],
    morning: ranges[0] ?? '',
    afternoon: ranges[1] ?? '',
    model: live.pricing.model,
    commands: '',
    stats: freshStats(live.pricing.currency),
    agents: [],
  };
}

/**
 * Schemastery validation for {@link Config}.
 *
 * The fields the settings page edits carry `.volatile()` on dsh ≥ 0.1.7-rc.2
 * (which makes them live-editable without a plugin remount) and stay plain on
 * older schemastery, where `volatileField` is a no-op. Non-volatile fields
 * (targets / enforcement / mode / startPolicy / poll timing) are composition
 * only — edit them in the profile's `cordis.patch.yml`.
 */
export const Config = z.object({
  enabled: volatileField(z.boolean().default(true)),
  targets: z.array(z.union([
    z.const('goal'),
    z.const('headless'),
    z.const('subagent'),
    z.const('interactive'),
  ])).default(['goal']),
  windows: volatileField(z.object({
    zone: z.string().default(DEFAULT_WINDOWS.zone),
    peak: z.array(z.object({
      days: z.array(z.string()).default([]),
      ranges: z.array(z.string()).default([]),
    })).default(DEFAULT_WINDOWS.peak),
  }).default(DEFAULT_WINDOWS)),
  leadMinutes: volatileField(z.number().min(0).default(5)),
  enforcement: z.union([z.const('gate'), z.const('cancel')]).default('gate'),
  mode: z.union([z.const('park'), z.const('defer'), z.const('off')]).default('park'),
  pricing: volatileField(z.object({
    // Which official DeepSeek price table to bill the estimate against
    // (lib/stats.js DEEPSEEK_PRICING); 'custom' uses `perMillion` verbatim.
    model: z.union([z.const('flash'), z.const('pro'), z.const('custom')]).default('flash'),
    currency: z.string().default('CNY'),
    perMillion: z.object({
      input: z.number().default(3.0),
      cacheRead: z.number().default(0.1),
      cacheWrite: z.number().default(0),
      output: z.number().default(9.0),
    }).default({}),
    peakFactor: z.number().default(1),
    offPeakFactor: z.number().default(0.5),
  }).default({})),
  startPolicy: z.union([z.const('park'), z.const('run')]).default('park'),
  pollIntervalMs: z.number().min(1000).default(30000),
  stateDir: z.string().default(''),
  /**
   * Settings namespace (profile entry id) the modern control plane addresses.
   * Empty = derive from the loader entry id, then fall back to `peak-shift`.
   * Only needed when this plugin is mounted under a non-default entry id.
   */
  settingsNamespace: z.string().default(''),
  /**
   * Control channel from the web card: `resume:<agentId>` or `resume-all` on
   * both generations. The host executes a changed value once and clears it.
   */
  commands: volatileField(z.string().default('')),
});

/** Install peak-shift for agents published after this plugin loads. */
export function apply(ctx, config) {
  /**
   * Plain, mutable view of everything the gate reads.
   *
   * `config` cannot serve this role directly: on modern dsh its `volatile()`
   * fields arrive as frozen `{ get }` references and a profile-patch edit must
   * not require a plugin remount. Both control planes therefore merge resolved
   * values into this object in place, and runtimes hold the same reference.
   */
  const live = {
    ...unwrapDeep({
      enabled: config.enabled,
      leadMinutes: config.leadMinutes,
      windows: config.windows,
      pricing: config.pricing,
    }),
    enabled: config.enabled !== false,
    commands: '',
    // Plain composition fields — never settings-managed, read straight through.
    targets: config.targets,
    enforcement: config.enforcement,
    mode: config.mode,
    startPolicy: config.startPolicy,
    pollIntervalMs: config.pollIntervalMs,
    stateDir: config.stateDir,
  };
  if (live.windows === undefined || live.windows === null) live.windows = { ...DEFAULT_WINDOWS };
  if (live.pricing === undefined || live.pricing === null) live.pricing = {};

  let policy = createWindowPolicy(live.windows);
  const goals = optionalService(ctx, 'goals');
  const headless = optionalService(ctx, 'headlessStartup') !== undefined;
  const runtimes = new Map();

  // The settings namespace: the legacy section name and the modern profile
  // entry id are the same string for the shipped `cordis.patch.yml`.
  const settingsService = optionalService(ctx, 'settings');
  const modern = isModernSettings(settingsService);
  const settingsNs = modern ? resolveNamespace(ctx, config) : SETTINGS_NAMESPACE;

  // ── master switch + window overrides (settings-backed, hot-reloaded) ─────
  // `state.enabled` is the single source of truth for whether peak-shift acts
  // at all. It is seeded from the composition config and updated live from the
  // active control plane; `/peak-shift`, the peak_shift_* tools, the web
  // settings page, and direct settings edits all converge here.
  const state = { enabled: live.enabled };
  const controller = {
    isEnabled: () => state.enabled,
    async setEnabled(value) {
      state.enabled = value !== false;
      live.enabled = state.enabled;
      await applyEnabledState();
      if (settingsService && settingsService.writable) {
        try {
          await settingsService.update(settingsNs, { enabled: state.enabled });
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
   * Read the flat window projection out of a resolved settings snapshot.
   *
   * Legacy snapshots are already flat (`days` + `morning`/`afternoon`); modern
   * ones nest (`windows.peak[0]`). Returns undefined when the snapshot carries
   * no window fields at all, so the previous policy keeps gating (fail-safe).
   */
  function flattenWindows(resolved) {
    if (resolved.windows !== undefined && resolved.windows !== null && typeof resolved.windows === 'object' && !Array.isArray(resolved.windows)) {
      const entry = resolved.windows.peak?.[0];
      if (entry === undefined) return undefined;
      return {
        days: Array.isArray(entry.days) ? entry.days.map(String) : [],
        ranges: Array.isArray(entry.ranges) ? entry.ranges.map(String) : [],
      };
    }
    const ranges = [resolved.morning, resolved.afternoon]
      .map((range) => String(range ?? '').trim())
      .filter((range) => range !== '');
    const days = Array.isArray(resolved.days) ? resolved.days.map(String) : [];
    return { days, ranges };
  }

  /**
   * Rebuild the live window policy from a flat projection. An invalid shape
   * (bad time format / unknown weekday) throws inside `createWindowPolicy` and
   * is ignored with a warning so the previous policy keeps gating — the
   * settings UI can never wedge the gate.
   */
  function rebuildWindows(days, ranges) {
    try {
      const windows = { zone: live.windows?.zone ?? DEFAULT_WINDOWS.zone, peak: [{ days, ranges }] };
      const nextPolicy = createWindowPolicy(windows); // throws on bad ranges/weekdays
      live.windows = windows;
      policy = nextPolicy;
      for (const { runtime } of runtimes.values()) runtime.policy = nextPolicy;
    } catch (error) {
      ctx.logger.warn(`peak-shift: ignoring invalid window settings (${error?.message ?? String(error)})`);
    }
  }

  /** Merge one resolved settings snapshot (either generation's shape) into `live`. */
  function applyResolved(resolved) {
    if (resolved === undefined || resolved === null || typeof resolved !== 'object') return;
    if ('enabled' in resolved) state.enabled = resolved.enabled !== false;
    live.enabled = state.enabled;

    const lead = Number(resolved.leadMinutes);
    if (Number.isFinite(lead) && lead >= 0) live.leadMinutes = lead;

    // Price table: legacy exposes a flat `model`, modern nests it under pricing.
    const model = resolved.model ?? (resolved.pricing === undefined ? undefined : resolved.pricing.model);
    if (model === 'flash' || model === 'pro' || model === 'custom') live.pricing.model = model;

    if (typeof resolved.commands === 'string') live.commands = resolved.commands;

    const flat = flattenWindows(resolved);
    if (flat !== undefined) rebuildWindows(flat.days, flat.ranges);
  }

  /** React to any control-plane change: switch, windows, price table, commands. */
  function onSettingsChange(resolved) {
    applyResolved(resolved);
    // A disable must never strand a paused task, whichever surface flipped it.
    void applyEnabledState();
    runCommand(live.commands);
  }

  // ── control channel: one-shot commands from the web card ──────────────────
  // The card writes `resume:<agentId>` or `resume-all` into the `commands`
  // field; the watcher executes a CHANGED value once and clears the field.
  // The first resolved value after mount is consumed without executing, so a
  // command stranded in the settings document by a crash is never replayed.
  let lastCommand = '';
  let firstResolve = true;

  /** Execute one parsed command; resume actions are safe to no-op. */
  async function executeCommand(raw) {
    const [action, ...rest] = raw.split(':');
    const arg = rest.join(':').trim();
    if (action === 'resume-all') {
      await Promise.allSettled([...runtimes.values()].map(async ({ runtime }) => {
        if (runtime.isPaused() && runtime.override !== 'force-paused') {
          await runtime.enterOffPeak().catch((error) => {
            ctx.logger.warn(`peak-shift: resume-all failed for ${runtime.agent.id}: ${error?.message ?? String(error)}`);
          });
        }
      }));
      return;
    }
    if (action === 'resume' && arg !== '') {
      const entry = [...runtimes.values()].find(({ runtime }) => runtime.agent.id === arg);
      if (entry !== undefined) {
        await entry.runtime.manualResume().catch((error) => {
          ctx.logger.warn(`peak-shift: card resume failed for ${arg}: ${error?.message ?? String(error)}`);
        });
      }
    }
  }

  function runCommand(raw) {
    const cmd = typeof raw === 'string' ? raw.trim() : '';
    if (firstResolve) {
      firstResolve = false;
      lastCommand = cmd;
      return;
    }
    if (cmd === '' || cmd === lastCommand) return;
    lastCommand = cmd;
    void Promise.resolve(executeCommand(cmd)).catch((error) => {
      ctx.logger.warn(`peak-shift: command ${JSON.stringify(cmd)} failed: ${error?.message ?? String(error)}`);
    }).then(() => {
      // Consume the command so it does not sit in the user document. When
      // settings are read-only the value stays, and lastCommand keeps
      // ignoring re-reads of the same string until it changes.
      if (settingsService && settingsService.writable) {
        Promise.resolve(settingsService.update(settingsNs, { commands: '' })).catch(() => {});
      }
    });
  }

  // ── live stats on the legacy settings base ────────────────────────────────
  // Per-agent last-known totals: a disposed agent keeps its contribution
  // visible, and a recreated session (sidecar-restored totals) overwrites its
  // own row instead of double-counting. Seeded from the sidecar directory at
  // mount, so the aggregate survives process restarts even for sessions that
  // never return.
  //
  // Modern dsh has no equivalent bag: its settings form is schema-derived and
  // its volatile references are frozen (the write symbol is internal to
  // cosmokit), so the host cannot publish runtime state through it. Savings
  // and the agent roster stay available through `/peak-shift status` and the
  // `peak_shift_stats` tool there.
  const lastTotals = new Map();
  for (const [id, totals] of loadPersistedTotals(live.stateDir)) lastTotals.set(id, totals);
  let legacyBase;

  /** Publish the aggregate savings snapshot and the agent roster onto the legacy base. */
  function refreshStats() {
    if (legacyBase === undefined) return;
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
    legacyBase.stats = {
      shiftedRequests,
      savedEstimate: Math.round(savedEstimate * 100) / 100,
      currency: live.pricing.currency,
      window: desc.window,
      nextPeakAt: desc.nextPeakAt === undefined ? '' : new Date(desc.nextPeakAt).toISOString(),
      nextOffPeakAt: desc.nextOffPeakAt === undefined ? '' : new Date(desc.nextOffPeakAt).toISOString(),
      updatedAt: Date.now(),
    };
    // Live agents only: disposed runtimes are not resumable from the panel.
    legacyBase.agents = [...runtimes.values()].map(({ runtime }) => ({
      id: runtime.agent.id,
      paused: runtime.isPaused(),
      manual: runtime.override === 'force-paused',
      reason: runtime.pauseReason ?? '',
      pausedAt: runtime.pausedAt ?? 0,
      park: runtime.parkQueue.length,
      shiftedRequests: runtime.stats.totals.shiftedRequests,
      savedEstimate: Math.round(runtime.stats.totals.savedEstimate * 100) / 100,
    }));
  }

  // ── install whichever settings control plane this dsh version provides ────
  if (modern) {
    installModernSettings(ctx, settingsService, settingsNs);
  } else if (installSettingsSection !== undefined) {
    installLegacySettings();
  } else {
    ctx.logger.warn(
      'peak-shift: this dsh version has no settings control plane (0.1.2–0.1.6); '
      + 'the gate runs from the composition config — edit the profile cordis.patch.yml to change windows',
    );
  }

  function installModernSettings(pluginCtx, settings, ns) {
    const read = () => {
      try {
        const rows = settings.describe();
        const row = Array.isArray(rows) ? rows.find((candidate) => candidate?.ns === ns) : undefined;
        return row?.value;
      } catch (error) {
        pluginCtx.logger.warn(`peak-shift: settings read failed: ${error?.message ?? String(error)}`);
        return undefined;
      }
    };
    // This entry ships its own page, so the settings service must not
    // auto-generate one from the schema.
    pluginCtx.inject(['settings'], (child) => {
      try {
        child.effect(
          () => child.settings.configure({ auto: false }, pluginCtx.fiber),
          'peak-shift: settings presentation',
        );
      } catch (error) {
        pluginCtx.logger.warn(`peak-shift: settings presentation configure failed: ${error?.message ?? String(error)}`);
      }
    });
    // Context listeners are disposed with this plugin's fiber, so no extra
    // effect wrapper is needed (the rest of this file attaches the same way).
    pluginCtx.on('settings/document-updated', (changed) => {
      if (changed !== ns) return;
      onSettingsChange(read());
    });
    // Seed `live` from the current form before any agent exists, so the very
    // first gate decision already reflects the persisted settings.
    onSettingsChange(read());
  }

  function installLegacySettings() {
    const base = deriveSettingsBase(live);
    live.enabled = base.enabled !== false;
    state.enabled = live.enabled;
    legacyBase = base;
    let settingsSource = () => base;
    installSettingsSection(ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, base, {
      setSource(thunk) { settingsSource = thunk; },
      onChange() { onSettingsChange(settingsSource() ?? base); },
    });
  }

  registerPeakShiftCommand(ctx, controller);

  ctx.on('agent/created', ({ agent }) => {
    if (runtimes.has(agent)) return;
    // Fail-safe: any peak-shift setup error is contained and logged so agent
    // creation / publication is never broken by this plugin.
    let runtime;
    try {
      runtime = new PeakShiftRuntime(ctx, live, agent, goals, policy, { headless }, controller);
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
  const stopPoll = ctx.interval(() => poll(), live.pollIntervalMs);
  function poll() {
    refreshStats();
    if (!controller.isEnabled()) return;
    const peak = policy.isPeak(Date.now() + live.leadMinutes * 60000);
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
