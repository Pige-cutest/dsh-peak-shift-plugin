import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { suite, assert } from './helpers.mjs';
import { createWindowPolicy } from '../lib/windows.js';
import { PeakShiftRuntime } from '../lib/runtime.js';

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

export const run = () => s.run();
