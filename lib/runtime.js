/**
 * @module dsh-peak-shift/runtime
 * Per-agent pause runtime: window gating, goal pause/resume, park queue, and
 * savings accounting.
 *
 * Lifecycle: created on `agent/created`, disposed on `agent/disposed`/unload.
 * The pre-step gate is the tight enforcement (no request is ever aborted
 * mid-stream under the default `enforcement: 'gate'`); the poll loop and a
 * precise resume timer drive goal pause/resume and park release.
 */

import { ensureGoalPaused, resumePausedGoal, activeGoal } from './goal.js';
import { createStatsTracker, effectivePerMillion } from './stats.js';
import { readStateFile, writeStateFile, stateFilePath } from './state.js';

/** Largest single sleep the wait loop uses; keeps wall-clock re-checks frequent. */
const MAX_WAIT_MS = 60000;

export class PeakShiftRuntime {
  /**
   * @param {object} rootCtx - global context (`sessions`, `logger`).
   * @param {object} config - validated plugin config.
   * @param {object} agent - live agent handle.
   * @param {object|undefined} goals - `ctx.goals`, may be undefined.
   * @param {object} policy - window policy from `createWindowPolicy`.
   * @param {object} env - `{ headless: boolean }` mode flags.
   */
  constructor(rootCtx, config, agent, goals, policy, env, controller) {
    this.rootCtx = rootCtx;
    this.agentCtx = agent.ctx;
    this.config = config;
    this.agent = agent;
    this.goals = goals;
    this.policy = policy;
    this.headless = env.headless;
    this.controller = controller ?? { isEnabled: () => true };

    this.state = 'active'; // 'active' | 'paused'
    this.override = undefined; // 'force-paused' | 'force-active' | undefined
    this.pauseReason = undefined;
    this.pausedAt = undefined;
    this.resumeDisposer = undefined;
    this.parkQueue = [];

    this.stats = createStatsTracker(config.pricing);
    this.stateFile = stateFilePath(agent.id, config.stateDir);
    this._writeChain = Promise.resolve();
    this._loadState();
    // `startPolicy: 'run'` lets a task created during peak run at peak prices
    // for that window instead of parking; cleared again at the next off-peak.
    if (this.override === undefined && config.startPolicy === 'run' && policy.isPeak(Date.now() + this._leadMs())) {
      this.override = 'force-active';
    }
    this.stats.ingest(agent.session.events);
  }

  _leadMs() {
    return this.config.leadMinutes * 60000;
  }

  // ── target / block decision ──────────────────────────────────────────────

  /** Whether this agent qualifies for peak-shift at all. */
  isTarget() {
    const targets = this.config.targets;
    if (targets.includes('interactive')) return true;
    if (targets.includes('headless') && this.headless) return true;
    if (targets.includes('subagent')) {
      const header = this.agent.session.header;
      if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return true;
    }
    if (targets.includes('goal') && activeGoal(this.goals, this.agent)) return true;
    return false;
  }

  isPaused() {
    return this.state === 'paused';
  }

  /** Whether the next request must be blocked right now (lead-aware). */
  shouldBlock(now) {
    if (this.override === 'force-active') return false;
    if (!this.controller.isEnabled()) return false; // master switch off
    if (!this.isTarget()) return false;
    if (this.override === 'force-paused') return true;
    return this.policy.isPeak(now + this._leadMs());
  }

  // ── pre-step gate ─────────────────────────────────────────────────────────

  /**
   * The `agent/pre-step` waterfall listener body.
   * @param {object} payload - `{ messages, turn, step, signal }`.
   * @param {Function} next - downstream continuation.
   * @returns {Promise<object>} a `PreStepDecision`.
   */
  async gate({ messages, turn, step, signal }, next) {
    try {
      return await this._gateInner({ messages, turn, step, signal }, next);
    } catch (error) {
      // Fail-safe: an internal gate error must never break the agent step.
      this.rootCtx.logger.warn(`peak-shift: gate error for ${this.agent.id}: ${error?.message ?? String(error)}; letting request through`);
      return next();
    }
  }

  async _gateInner({ messages, turn, step, signal }, next) {
    if (!this.shouldBlock(Date.now())) return next();
    await this._enterPause();

    const mode = this.config.mode;
    // An empty batch (a tool-loop continuation) must not be rejected — that
    // would drop the continuation. Hold it instead, like defer mode.
    if (mode === 'defer' || (mode === 'park' && messages.length === 0)) {
      this.stats.noteDeferred(turn, step);
      await this._waitUntilProceed(signal);
      return signal.aborted ? { kind: 'reject' } : next();
    }
    if (mode === 'park') {
      this.park(messages);
      return { kind: 'reject' };
    }
    // mode 'off': peak-shift disabled; let the request through untouched.
    return next();
  }

  // ── pause / resume ────────────────────────────────────────────────────────

  /** Enter the paused state. Idempotent. */
  async _enterPause() {
    if (this.state === 'paused') return false;
    this.state = 'paused';
    this.pausedAt = Date.now();
    await this._pauseGoalSafely();
    if (this.config.enforcement === 'cancel') {
      this.agent.cancel({ kind: 'hook', reason: 'peak-shift' }, { keepInbox: true });
    }
    this._armResumeTimer();
    this._persist();
    return true;
  }

  /** Leave the paused state; releases parked work and resumes goals. */
  async enterOffPeak() {
    this._clearResumeTimer();
    if (this.override === 'force-active') this.override = undefined;
    const wasPaused = this.state === 'paused';
    this.state = 'active';
    this.pauseReason = undefined;
    this.pausedAt = undefined;
    if (wasPaused) {
      await this._resumeGoalSafely();
      if (this.config.mode === 'park' && this.parkQueue.length > 0) this._releaseParked();
    }
    this._persist();
    return wasPaused;
  }

  /** Pause the goal driver without letting a goal-service failure break the gate. */
  async _pauseGoalSafely() {
    try {
      await ensureGoalPaused(this.rootCtx, this.agent, this.goals);
    } catch (error) {
      this.rootCtx.logger.warn(`peak-shift: goal pause failed for ${this.agent.id}: ${error?.message ?? String(error)}`);
    }
  }

  /** Resume the goal driver without letting a goal-service failure break the release. */
  async _resumeGoalSafely() {
    try {
      await resumePausedGoal(this.rootCtx, this.agent, this.goals);
    } catch (error) {
      this.rootCtx.logger.warn(`peak-shift: goal resume failed for ${this.agent.id}: ${error?.message ?? String(error)}`);
    }
  }

  manualPause(reason) {
    this.override = 'force-paused';
    this.pauseReason = reason;
    return this._enterPause();
  }

  async manualResume() {
    this.override = undefined;
    return this.enterOffPeak();
  }

  // ── park queue ────────────────────────────────────────────────────────────

  park(messages) {
    this.parkQueue.push(...messages);
    this.stats.noteParked(messages.map((m) => m.id));
    this._persist();
  }

  _releaseParked() {
    const held = this.parkQueue;
    this.parkQueue = [];
    for (const message of held) this.agent.steer(message);
  }

  // ── resume timer ──────────────────────────────────────────────────────────

  _armResumeTimer() {
    this._clearResumeTimer();
    if (this.override === 'force-paused') return;
    const delay = this.policy.msUntilOffPeak(Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    this.resumeDisposer = this.agentCtx.timer.timeout(() => {
      void this.enterOffPeak().catch((error) => {
        this.rootCtx.logger.warn(`peak-shift: timed resume failed for ${this.agent.id}: ${error?.message ?? String(error)}`);
      });
    }, delay);
  }

  _clearResumeTimer() {
    if (this.resumeDisposer !== undefined) {
      try {
        this.resumeDisposer();
      } catch {
        /* already fired */
      }
      this.resumeDisposer = undefined;
    }
  }

  // ── wait helper (defer mode and empty-batch park) ─────────────────────────

  /** Resolve when `shouldBlock` is false again or the turn signal aborts. */
  _waitUntilProceed(signal) {
    const proceed = () => !this.shouldBlock(Date.now());
    if (proceed() || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => done();
      const tick = () => {
        if (proceed() || signal.aborted) return done();
        timer = setTimeout(tick, this._waitDelay());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(tick, this._waitDelay());
    });
  }

  _waitDelay() {
    return Math.max(100, Math.min(this.policy.msUntilOffPeak(Date.now()), MAX_WAIT_MS));
  }

  // ── persistence / restore ─────────────────────────────────────────────────

  _loadState() {
    const saved = readStateFile(this.stateFile);
    if (!saved || saved.version !== 1) return;
    if (Array.isArray(saved.parkQueue)) this.parkQueue = saved.parkQueue.filter((m) => m && typeof m === 'object');
    if (saved.stats && typeof saved.stats === 'object') {
      this.stats.totals.shiftedRequests = Number(saved.stats.shiftedRequests) || 0;
      this.stats.totals.savedEstimate = Number(saved.stats.savedEstimate) || 0;
    }
    if (typeof saved.reason === 'string') this.pauseReason = saved.reason;
    if (typeof saved.pausedAt === 'number') this.pausedAt = saved.pausedAt;
    if (saved.override === 'force-paused') this.override = 'force-paused';
  }

  /** Re-apply durable state after a session resume. */
  onSessionStart() {
    this._loadState();
    this.stats.ingest(this.agent.session.events);
    if (this.shouldBlock(Date.now())) {
      void this._enterPause();
    }
  }

  _persist() {
    const totals = this.stats.totals;
    const state = {
      version: 1,
      state: this.state,
      override: this.override,
      reason: this.pauseReason,
      pausedAt: this.pausedAt,
      parkQueue: this.parkQueue,
      stats: { shiftedRequests: totals.shiftedRequests, savedEstimate: totals.savedEstimate },
    };
    // Serialize sidecar writes so a stale park write can never land after a
    // newer release write and resurrect cleared state.
    this._writeChain = this._writeChain.then(() => writeStateFile(this.stateFile, state)).catch((error) => {
      this.rootCtx.logger.warn(`peak-shift: failed to persist state for ${this.agent.id}: ${error?.message ?? String(error)}`);
    });
  }

  // ── views for tools ───────────────────────────────────────────────────────

  statusView() {
    const now = Date.now();
    const desc = this.policy.describe(now);
    const totals = this.stats.totals;
    return {
      enabled: this.controller.isEnabled(),
      state: this.isPaused() ? 'paused' : 'active',
      window: this.policy.isPeak(now + this._leadMs()) ? 'peak' : 'off-peak',
      mode: this.config.mode,
      nextPeakAt: desc.nextPeakAt === undefined ? undefined : new Date(desc.nextPeakAt).toISOString(),
      nextOffPeakAt: desc.nextOffPeakAt === undefined ? undefined : new Date(desc.nextOffPeakAt).toISOString(),
      shiftedRequests: totals.shiftedRequests,
      savedEstimate: round2(totals.savedEstimate),
      currency: this.config.pricing.currency,
    };
  }

  statsView() {
    const totals = this.stats.totals;
    return {
      model: this.config.pricing.model,
      shiftedRequests: totals.shiftedRequests,
      savedEstimate: round2(totals.savedEstimate),
      currency: this.config.pricing.currency,
      perMillion: { ...effectivePerMillion(this.config.pricing) },
      peakFactor: this.config.pricing.peakFactor,
      offPeakFactor: this.config.pricing.offPeakFactor,
    };
  }

  dispose() {
    this._clearResumeTimer();
    const totals = this.stats.totals;
    if (
      this.parkQueue.length > 0 ||
      this.isPaused() ||
      this.override !== undefined ||
      totals.shiftedRequests > 0 ||
      totals.savedEstimate > 0
    ) {
      this._persist();
    }
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
