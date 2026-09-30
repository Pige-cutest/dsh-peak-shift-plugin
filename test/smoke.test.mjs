import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { suite, assert } from './helpers.mjs';
import { createWindowPolicy } from '../lib/windows.js';
import { PeakShiftRuntime } from '../lib/runtime.js';
import { apply } from '../lib/index.js';

// Every state-dir teardown goes through removeStateDir(): a host path can still
// be flushing a sidecar write (the runtime persists asynchronously, and the
// resume/disable chains are fire-and-forget) when the test's finally runs, and
// an rmdir that races that rename lands on ENOTEMPTY.
//
// Best-effort by design: teardown never fails a test. Some sandboxes interpose
// their own delete policy on fs.rmSync, which can leave the directory itself
// behind after emptying it; that is the sandbox's business, not the plugin's.
async function removeStateDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Minimal mock context: captures listeners, intervals, effects. */
function makeMockCtx() {
  const listeners = new Map();
  const intervals = [];
  const ctx = {
    fiber: { state: 2 }, // ACTIVE — read by dsh-settings isUnloading()
    logger: { warn() {}, info() {}, error() {} },
    get() { return undefined; },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return () => {};
    },
    interval(callback) {
      intervals.push(callback);
      return () => {};
    },
    effect() {
      return () => {};
    },
    // settings/commands are optional; without a provider the injected callbacks
    // simply never run (mirrors a composition where the service is absent).
    inject() {},
  };
  return { ctx, listeners, intervals };
}

/** A mock settings provider that can re-resolve and notify namespace watchers. */
function makeMockSettings() {
  const registrations = new Map();
  const settings = {
    writable: true,
    updates: [],
    async update(ns, patch) {
      const reg = registrations.get(ns);
      if (reg === undefined) throw new Error(`unknown namespace ${ns}`);
      settings.updates.push({ ns, patch });
      reg.resolved = reg.schema({ ...reg.resolved, ...patch });
      for (const watcher of [...reg.watchers]) watcher(reg.resolved);
    },
    register(ns, schema, options) {
      const reg = {
        ns,
        schema,
        base: options?.base,
        resolved: schema(options?.base ?? {}),
        watchers: new Set(),
      };
      registrations.set(ns, reg);
      return {
        get: () => reg.resolved,
        watch(callback) {
          reg.watchers.add(callback);
          return () => reg.watchers.delete(callback);
        },
        update: (patch) => settings.update(ns, patch),
      };
    },
    /** Simulate an external settings.yaml change: re-resolve and notify. */
    publishSection(ns, section) {
      const reg = registrations.get(ns);
      if (!reg) return;
      reg.resolved = reg.schema({ ...(reg.base ?? {}), ...section });
      for (const watcher of [...reg.watchers]) watcher(reg.resolved);
    },
    /** Drive `ctx.inject(['settings'], cb)` and `ctx.inject(['commands'], cb)` with this provider. */
    mountInto(mockCtx) {
      mockCtx.inject = (deps, callback) => {
        if (deps.includes('settings')) callback({ settings, effect: () => () => {}, get: () => settings });
        if (deps.includes('commands')) callback({ commands: { register() {} }, effect: () => () => {}, get: () => settings });
      };
    },
    /** The live `base` object a namespace registered with (identity-stable). */
    baseOf(ns) {
      return registrations.get(ns)?.base;
    },
  };
  return settings;
}

/** Emit a captured event with a payload. */
function emit(listeners, event, payload) {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

/** Minimal agent whose scope has NO `tools` (graceful-skip path) and a working effect(). */
function makeMockAgent(id) {
  const agentListeners = new Map();
  const agent = {
    id,
    ctx: {
      on(event, listener) {
        if (!agentListeners.has(event)) agentListeners.set(event, []);
        agentListeners.get(event).push(listener);
        return () => {};
      },
      effect(callback) {
        const disposer = callback();
        return () => { if (disposer) disposer(); };
      },
      // no `tools`: peak_shift_* tools must be skipped, not throw
      timer: { timeout() { return () => {}; } },
    },
    session: { header: {}, events: [] },
    cancel() {},
    steer() {},
  };
  agent._listeners = agentListeners;
  return agent;
}

const s = suite('smoke');

s.test('plugin modules load and Config validates the official default rule', async () => {
  const { Config } = await import('../lib/index.js');
  const res = await Config['~standard'].validate({});
  const value = res.value;
  assert(value !== undefined && typeof value === 'object', 'empty config validates');
  assert(value.windows.zone === 'Asia/Shanghai', 'default zone is Asia/Shanghai');
  const peak = value.windows.peak[0];
  assert(Array.isArray(peak.days) && peak.days.join(',') === 'mon,tue,wed,thu,fri', 'default weekdays Mon-Fri');
  assert(peak.ranges.join(',') === '09:00-12:00,14:00-18:00', 'default ranges');
  assert(value.mode === 'park', 'default mode park');
  assert(value.pricing.model === 'flash', 'default price table is the official flash preset');
  assert(value.pricing.currency === 'CNY', 'estimates are denominated in CNY');
  assert(value.pricing.offPeakFactor === 0.5, 'off-peak is half price');
  assert(value.pricing.peakFactor === 1, 'peak is full price');
});

s.test('gate parks a peak-time request, pauses the goal, and releases on resume', async () => {
  const originalNow = Date.now;
  const MON_11_00 = Date.UTC(2026, 7, 24, 3, 0); // 2026-08-24 11:00 CST
  const MON_13_00 = Date.UTC(2026, 7, 24, 5, 0); // 2026-08-24 13:00 CST
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));

  const timer = { disposers: [], timeout(callback, delay) { const d = () => {}; timer.disposers.push({ callback, delay }); return d; } };
  const rootCtx = {
    sessions: { flush: async () => true },
    logger: { warn() {}, info() {} },
    get() { return undefined; },
  };

  const steered = [];
  const agent = {
    id: 'session-test-park',
    ctx: { timer },
    session: { header: {}, events: [] },
    cancel() {},
    steer(message) { steered.push(message); },
  };

  const goals = {
    goal: { id: 'g1', revision: 1, phase: 'active' },
    paused: null,
    resumed: null,
    get() { return this.goal; },
    pause(agent, ref) { this.paused = ref; this.goal = { ...this.goal, phase: 'paused', revision: ref.revision + 1 }; },
    resume(agent, ref) { this.resumed = ref; this.goal = { ...this.goal, phase: 'active', revision: ref.revision + 1 }; },
  };

  const config = {
    targets: ['goal'],
    windows: { zone: 'Asia/Shanghai', peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: ['09:00-12:00', '14:00-18:00'] }] },
    leadMinutes: 5,
    enforcement: 'gate',
    mode: 'park',
    pricing: { currency: 'USD', perMillion: { input: 0.27, cacheRead: 0.07, cacheWrite: 1.07, output: 1.1 }, peakFactor: 1, offPeakFactor: 0.5 },
    startPolicy: 'park',
    pollIntervalMs: 30000,
    stateDir,
  };

  try {
    Date.now = () => MON_11_00;
    const policy = createWindowPolicy(config.windows);
    const runtime = new PeakShiftRuntime(rootCtx, config, agent, goals, policy, { headless: false });
    assert(runtime.isPaused() === false, 'starts active');

    const messages = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }];
    let nextCalled = false;
    const next = async () => { nextCalled = true; return { kind: 'enter', messages }; };
    const decision = await runtime.gate({ messages, turn: 1, step: 1, signal: new AbortController().signal }, next);

    assert(decision.kind === 'reject', 'park mode rejects the step');
    assert(nextCalled === false, 'downstream next() not called while parked');
    assert(runtime.isPaused(), 'runtime is paused');
    assert(runtime.parkQueue.length === 1, 'message is parked');
    assert(goals.paused !== null, 'goal paused');
    assert(goals.paused.id === 'g1', 'goal ref id matches');

    // Advance to off-peak and resume.
    Date.now = () => MON_13_00;
    await runtime.enterOffPeak();
    assert(runtime.isPaused() === false, 'resumed to active');
    assert(steered.length === 1, 'parked message steered back');
    assert(steered[0].id === 'm1', 'same message identity restored');
    assert(goals.resumed !== null, 'goal resumed');
    assert(runtime.parkQueue.length === 0, 'park queue drained');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('defer mode with an aborted signal exits immediately with reject', async () => {
  const originalNow = Date.now;
  const MON_11_00 = Date.UTC(2026, 7, 24, 3, 0);
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));

  const timer = { timeout() { return () => {}; } };
  const rootCtx = { sessions: { flush: async () => true }, logger: { warn() {} }, get() { return undefined; } };
  const agent = { id: 'session-test-defer', ctx: { timer }, session: { header: {}, events: [] }, cancel() {}, steer() {} };

  const config = {
    targets: ['interactive'],
    windows: { zone: 'Asia/Shanghai', peak: [{ days: [], ranges: ['00:00-23:59'] }] },
    leadMinutes: 0,
    enforcement: 'gate',
    mode: 'defer',
    pricing: { currency: 'USD', perMillion: { input: 0.27, cacheRead: 0.07, cacheWrite: 1.07, output: 1.1 }, peakFactor: 1, offPeakFactor: 0.5 },
    startPolicy: 'park',
    pollIntervalMs: 30000,
    stateDir,
  };

  try {
    Date.now = () => MON_11_00;
    const policy = createWindowPolicy(config.windows);
    const runtime = new PeakShiftRuntime(rootCtx, config, agent, undefined, policy, { headless: false });
    const controller = new AbortController();
    controller.abort();
    const decision = await runtime.gate({ messages: [{ id: 'x' }], turn: 1, step: 1, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }));
    assert(decision.kind === 'reject', 'aborted defer gate rejects');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('poll() iterates runtimes, not cleanup disposers (regression)', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  try {
    const { ctx, listeners, intervals } = makeMockCtx();
    apply(ctx, { ...validated, stateDir });
    const agent = makeMockAgent('session-poll-test');
    emit(listeners, 'agent/created', { agent });
    assert(intervals.length === 1, 'one poll interval registered');
    // Must not throw: values are { runtime, cleanup }, and isTarget() exists.
    intervals[0]();
    // Dispose path must also tolerate the entry shape.
    emit(listeners, 'agent/disposed', { agent });
  } finally {
    await removeStateDir(stateDir);
  }
});

s.test('settings hot-reload toggle disables the pre-step gate', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0); // 2026-08-24 11:00 CST (Mon peak)
  try {
    const { ctx, listeners } = makeMockCtx();
    const settings = makeMockSettings();
    settings.mountInto(ctx);
    // 'interactive' makes the mock agent (no goal) a peak-shift target.
    apply(ctx, { ...validated, stateDir, targets: ['interactive'] });

    const agent = makeMockAgent('session-toggle-test');
    emit(listeners, 'agent/created', { agent });
    const preStepListeners = agent._listeners.get('agent/pre-step') ?? [];
    assert(preStepListeners.length >= 1, 'pre-step gate registered');

    Date.now = () => PEAK;
    const invokeGate = async () => preStepListeners[0](
      { agent, messages: [{ id: 'm', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );

    const before = await invokeGate();
    assert(before.kind === 'reject', 'gate blocks while enabled and peak');

    // External settings.yaml change flips the master switch off.
    settings.publishSection('peak-shift', { enabled: false });
    const after = await invokeGate();
    assert(after.kind === 'enter', 'gate lets requests through once disabled');

    // And back on.
    settings.publishSection('peak-shift', { enabled: true });
    const again = await invokeGate();
    assert(again.kind === 'reject', 'gate blocks again after re-enable');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('settings window edits hot-rebuild the live policy (invalid input keeps the previous one)', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const MON_07_15 = Date.UTC(2026, 7, 23, 23, 15); // 2026-08-24 07:15 CST (off-peak by default)
  try {
    const { ctx, listeners } = makeMockCtx();
    const settings = makeMockSettings();
    settings.mountInto(ctx);
    apply(ctx, { ...validated, stateDir, targets: ['interactive'] });

    const agent = makeMockAgent('session-windows-test');
    emit(listeners, 'agent/created', { agent });
    const gate = (agent._listeners.get('agent/pre-step') ?? [])[0];
    assert(typeof gate === 'function', 'pre-step gate registered');

    Date.now = () => MON_07_15;
    const invoke = () => gate(
      { messages: [{ id: 'm', role: 'user', content: [], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );

    let decision = await invoke();
    assert(decision.kind === 'enter', '07:15 is off-peak under the default windows');

    settings.publishSection('peak-shift', { morning: '07:00-07:30' });
    decision = await invoke();
    assert(decision.kind === 'reject', 'window edit rebuilds the live policy: 07:15 is now peak');

    settings.publishSection('peak-shift', { morning: '25:00-26:00' });
    decision = await invoke();
    assert(decision.kind === 'reject', 'invalid window edit is ignored, previous policy keeps gating');

    settings.publishSection('peak-shift', { morning: '07:00-07:30', days: ['funday'] });
    decision = await invoke();
    assert(decision.kind === 'reject', 'invalid weekday list is ignored too');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('poll() publishes aggregated savings onto the settings base, surviving agent disposal', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0); // 2026-08-24 11:00 CST (Mon peak)
  try {
    const { ctx, listeners, intervals } = makeMockCtx();
    const settings = makeMockSettings();
    settings.mountInto(ctx);
    apply(ctx, { ...validated, stateDir });

    // Sidecar-restored totals: two past sessions that already shifted work.
    const sidecar = (id, shifted, saved) => writeFileSync(
      join(stateDir, `${id}.json`),
      JSON.stringify({ version: 1, state: 'active', parkQueue: [], stats: { shiftedRequests: shifted, savedEstimate: saved } }),
    );
    sidecar('session-stats-a', 5, 0.42);
    sidecar('session-stats-b', 2, 0.13);

    const agentA = makeMockAgent('session-stats-a');
    const agentB = makeMockAgent('session-stats-b');
    emit(listeners, 'agent/created', { agent: agentA });
    emit(listeners, 'agent/created', { agent: agentB });

    Date.now = () => PEAK;
    intervals[0](); // one poll tick: refreshStats() runs first, before the enabled check

    const base = settings.baseOf('peak-shift');
    assert(base !== undefined, 'namespace registered with our base object');
    const stats = base.stats;
    assert(stats.shiftedRequests === 7, `aggregate shiftedRequests (got ${stats.shiftedRequests})`);
    assert(Math.abs(stats.savedEstimate - 0.55) < 1e-9, `aggregate savedEstimate (got ${stats.savedEstimate})`);
    assert(stats.window === 'peak', 'window reflects the policy at poll time');
    assert(typeof stats.nextOffPeakAt === 'string' && stats.nextOffPeakAt !== '', 'next off-peak instant published');
    assert(stats.updatedAt === PEAK, 'updatedAt stamped');

    // A recreated session overwrites its own row; a disposed agent keeps it.
    emit(listeners, 'agent/disposed', { agent: agentA });
    emit(listeners, 'agent/created', { agent: agentA }); // sidecar still says 5
    intervals[0]();
    assert(base.stats.shiftedRequests === 7, 'no double-count after re-create');

    emit(listeners, 'agent/disposed', { agent: agentB });
    intervals[0]();
    assert(base.stats.shiftedRequests === 7, 'disposed agent keeps its contribution');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('aggregate stats are seeded from sidecar files before any agent exists', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0);
  try {
    writeFileSync(
      join(stateDir, 'session-old.json'),
      JSON.stringify({ version: 1, parkQueue: [], stats: { shiftedRequests: 4, savedEstimate: 0.5 } }),
    );
    writeFileSync(join(stateDir, 'not-peak-shift.json'), 'not json');

    Date.now = () => PEAK;
    const { ctx, intervals } = makeMockCtx();
    const settings = makeMockSettings();
    settings.mountInto(ctx);
    apply(ctx, { ...validated, stateDir });

    intervals[0]();
    const { stats } = settings.baseOf('peak-shift');
    assert(stats.shiftedRequests === 4, `seeded shiftedRequests (got ${stats.shiftedRequests})`);
    assert(Math.abs(stats.savedEstimate - 0.5) < 1e-9, `seeded savedEstimate (got ${stats.savedEstimate})`);
    assert(settings.baseOf('peak-shift').agents.length === 0, 'no agents yet');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('agents snapshot lands on the base and the card resume command releases a parked agent', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0); // 2026-08-24 11:00 CST (Mon peak)
  try {
    const { ctx, listeners, intervals } = makeMockCtx();
    const settings = makeMockSettings();
    settings.mountInto(ctx);
    ctx.get = (name) => (name === 'settings' ? settings : undefined);
    apply(ctx, { ...validated, stateDir, targets: ['interactive'] });

    const steered = [];
    const agent = makeMockAgent('session-panel-a');
    agent.steer = (message) => steered.push(message);
    emit(listeners, 'agent/created', { agent });
    const gate = (agent._listeners.get('agent/pre-step') ?? [])[0];

    Date.now = () => PEAK;
    // Park one request through the gate.
    await gate(
      { messages: [{ id: 'm1', role: 'user', content: [], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );

    intervals[0]();
    let roster = settings.baseOf('peak-shift').agents;
    assert(roster.length === 1 && roster[0].id === 'session-panel-a', 'agent listed on the base');
    assert(roster[0].paused === true, 'agent reported paused');
    assert(roster[0].park === 1, 'park queue size reported');

    // The card writes a resume command; the host executes and consumes it.
    settings.publishSection('peak-shift', { commands: 'resume:session-panel-a' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(steered.length === 1 && steered[0].id === 'm1', 'parked message released by the command');
    assert(settings.updates.some((update) => update.ns === 'peak-shift' && update.patch.commands === ''), 'command field cleared after execution');

    intervals[0]();
    roster = settings.baseOf('peak-shift').agents;
    assert(roster[0].paused === false && roster[0].park === 0, 'roster reflects the resumed state');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

/**
 * Mock MODERN settings provider (dsh ≥ 0.1.7-rc.2, incl. 0.2.x): a
 * `SettingsForms`-shaped service keyed by profile entry id, whose form values
 * the host reads through `describe()` and reacts to via
 * `settings/document-updated`.
 */
function makeModernSettings() {
  const entries = new Map();
  const settings = {
    writable: true,
    updates: [],
    configureCalls: [],
    describe() {
      return [...entries.values()].map((entry) => ({
        ns: entry.ns,
        revision: entry.revision,
        value: entry.value,
        applies: 'live',
      }));
    },
    configure(presentation, owner) {
      settings.configureCalls.push({ presentation, owner });
      return () => {};
    },
    async update(ns, patch, expectedRevision) {
      const entry = entries.get(ns);
      if (entry === undefined) throw new Error(`No configurable plugin entry "${ns}"`);
      if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
        throw new Error(`settings namespace "${ns}" changed since it was read`);
      }
      settings.updates.push({ ns, patch, expectedRevision });
      entry.value = { ...entry.value, ...patch };
      entry.revision += 1;
      return undefined;
    },
    /** Register/replace one entry's projected form values. */
    set(ns, value) {
      const previous = entries.get(ns);
      entries.set(ns, { ns, revision: previous === undefined ? 0 : previous.revision + 1, value });
      return entries.get(ns);
    },
    /** The resolved form value of one entry. */
    valueOf(ns) {
      return entries.get(ns)?.value;
    },
    /** Drive `ctx.inject(['settings'], cb)` with this provider. */
    mountInto(mockCtx) {
      mockCtx.get = (name) => (name === 'settings' ? settings : undefined);
      mockCtx.inject = (deps, callback) => {
        if (!deps.includes('settings')) return;
        callback({ settings, effect: (fn) => { fn(); return () => {}; }, get: () => settings });
      };
    },
  };
  return settings;
}

/** The projected form value the plugin's Config volatile fields produce. */
function modernFormValue(overrides = {}) {
  return {
    enabled: true,
    leadMinutes: 5,
    windows: { zone: 'Asia/Shanghai', peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: ['09:00-12:00', '14:00-18:00'] }] },
    pricing: { model: 'flash', currency: 'CNY' },
    commands: '',
    ...overrides,
  };
}

s.test('modern settings: the projected Config form drives the switch and the window policy', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0); // 2026-08-24 11:00 CST (Mon peak)
  const MON_07_15 = Date.UTC(2026, 7, 23, 23, 15); // 2026-08-24 07:15 CST (off-peak)
  try {
    const { ctx, listeners } = makeMockCtx();
    const settings = makeModernSettings();
    settings.set('peak-shift', modernFormValue());
    settings.mountInto(ctx);
    apply(ctx, { ...validated, stateDir, targets: ['interactive'] });

    const agent = makeMockAgent('session-modern');
    emit(listeners, 'agent/created', { agent });
    const gate = (agent._listeners.get('agent/pre-step') ?? [])[0];
    assert(typeof gate === 'function', 'pre-step gate registered on the modern path');
    const invoke = () => gate(
      { messages: [{ id: 'm', role: 'user', content: [], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );

    // The plugin declares it ships its own page, so no form is auto-generated.
    assert(settings.configureCalls.length === 1, 'settings presentation configured once');
    assert(settings.configureCalls[0].presentation.auto === false, 'auto page generation disabled');

    Date.now = () => PEAK;
    assert((await invoke()).kind === 'reject', 'gate blocks while enabled and peak');

    // A settings-page write lands in the user layer and emits the host event.
    settings.set('peak-shift', modernFormValue({ enabled: false }));
    emit(listeners, 'settings/document-updated', 'peak-shift');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert((await invoke()).kind === 'enter', 'gate lets requests through once disabled');

    const other = await invoke();
    assert(other.kind === 'enter', 'stays open');
    settings.set('peak-shift', modernFormValue({ enabled: true }));
    emit(listeners, 'settings/document-updated', 'peak-shift');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert((await invoke()).kind === 'reject', 'gate blocks again after re-enable');

    // Nested window edits (the modern shape) rebuild the live policy.
    Date.now = () => MON_07_15;
    assert((await invoke()).kind === 'enter', '07:15 is off-peak under the default windows');
    settings.set('peak-shift', modernFormValue({ windows: { zone: 'Asia/Shanghai', peak: [{ days: ['mon'], ranges: ['07:00-07:30'] }] } }));
    emit(listeners, 'settings/document-updated', 'peak-shift');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert((await invoke()).kind === 'reject', 'nested window edit rebuilt the policy');

    // An unrelated namespace must not re-resolve our own form.
    settings.set('llm-deepseek', { baseURL: 'https://api.deepseek.com' });
    emit(listeners, 'settings/document-updated', 'llm-deepseek');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert((await invoke()).kind === 'reject', 'other namespaces are ignored');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('modern settings: a disabled form resumes paused tasks and never strands them', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0); // Mon 11:00 CST
  try {
    const { ctx, listeners } = makeMockCtx();
    const settings = makeModernSettings();
    settings.set('peak-shift', modernFormValue());
    settings.mountInto(ctx);
    apply(ctx, { ...validated, stateDir, targets: ['interactive'] });

    const steered = [];
    const agent = makeMockAgent('session-modern-disable');
    agent.steer = (message) => steered.push(message);
    emit(listeners, 'agent/created', { agent });
    const gate = (agent._listeners.get('agent/pre-step') ?? [])[0];

    Date.now = () => PEAK;
    await gate(
      { messages: [{ id: 'm1', role: 'user', content: [], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );

    settings.set('peak-shift', modernFormValue({ enabled: false }));
    emit(listeners, 'settings/document-updated', 'peak-shift');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(steered.length === 1 && steered[0].id === 'm1', 'parked message released when the form disables peak-shift');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('modern settings: the control channel is consumed through the entry form', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0);
  try {
    const { ctx, listeners } = makeMockCtx();
    const settings = makeModernSettings();
    settings.set('peak-shift', modernFormValue());
    settings.mountInto(ctx);
    apply(ctx, { ...validated, stateDir, targets: ['interactive'] });

    const steered = [];
    const agent = makeMockAgent('session-modern-cmd');
    agent.steer = (message) => steered.push(message);
    emit(listeners, 'agent/created', { agent });
    const gate = (agent._listeners.get('agent/pre-step') ?? [])[0];

    Date.now = () => PEAK;
    await gate(
      { messages: [{ id: 'm1', role: 'user', content: [], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );

    settings.set('peak-shift', modernFormValue({ commands: 'resume-all' }));
    emit(listeners, 'settings/document-updated', 'peak-shift');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(steered.length === 1 && steered[0].id === 'm1', 'resume-all released the parked message');
    assert(
      settings.updates.some((update) => update.ns === 'peak-shift' && update.patch.commands === ''),
      'command field cleared through the entry form',
    );
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('modern settings: an explicit settingsNamespace pins the entry id', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0);
  try {
    const { ctx, listeners } = makeMockCtx();
    const settings = makeModernSettings();
    settings.set('renamed-entry', modernFormValue());
    settings.mountInto(ctx);
    apply(ctx, { ...validated, stateDir, targets: ['interactive'], settingsNamespace: 'renamed-entry' });

    const agent = makeMockAgent('session-modern-renamed');
    emit(listeners, 'agent/created', { agent });
    const gate = (agent._listeners.get('agent/pre-step') ?? [])[0];

    Date.now = () => PEAK;
    const blocked = await gate(
      { messages: [{ id: 'm', role: 'user', content: [], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    assert(blocked.kind === 'reject', 'the renamed entry drives the gate');

    settings.set('renamed-entry', modernFormValue({ enabled: false }));
    emit(listeners, 'settings/document-updated', 'renamed-entry');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const open = await gate(
      { messages: [{ id: 'm', role: 'user', content: [], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    assert(open.kind === 'enter', 'the renamed entry hot-reloads the switch');
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

s.test('a composition with no settings control plane still gates from the composition config', async () => {
  const { Config } = await import('../lib/index.js');
  const validated = Config['~standard'].validate({}).value;
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-shift-test-'));
  const originalNow = Date.now;
  const PEAK = Date.UTC(2026, 7, 24, 3, 0);
  try {
    // The dsh 0.1.2–0.1.6 gap: no installSettingsSection, no SettingsForms.
    const { ctx, listeners, intervals } = makeMockCtx();
    ctx.get = () => ({ writable: true, update() {}, register() {} });
    apply(ctx, { ...validated, stateDir, targets: ['interactive'] });

    const agent = makeMockAgent('session-gap');
    emit(listeners, 'agent/created', { agent });
    const gate = (agent._listeners.get('agent/pre-step') ?? [])[0];

    Date.now = () => PEAK;
    const decision = await gate(
      { messages: [{ id: 'm', role: 'user', content: [], source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    );
    assert(decision.kind === 'reject', 'gate still enforces the composition windows');
    intervals[0](); // poll must be a no-op, not a throw, without a legacy base
  } finally {
    Date.now = originalNow;
    await removeStateDir(stateDir);
  }
});

export const run = () => s.run();
