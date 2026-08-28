import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { suite, assert } from './helpers.mjs';
import { createWindowPolicy } from '../lib/windows.js';
import { PeakShiftRuntime } from '../lib/runtime.js';
import { apply } from '../lib/index.js';

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
        async update(patch) {
          reg.resolved = reg.schema({ ...reg.resolved, ...patch });
          for (const watcher of [...reg.watchers]) watcher(reg.resolved);
        },
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
    rmSync(stateDir, { recursive: true, force: true });
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
    rmSync(stateDir, { recursive: true, force: true });
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
    rmSync(stateDir, { recursive: true, force: true });
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
    rmSync(stateDir, { recursive: true, force: true });
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
    rmSync(stateDir, { recursive: true, force: true });
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
    rmSync(stateDir, { recursive: true, force: true });
  }
});

export const run = () => s.run();
