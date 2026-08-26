/**
 * @module dsh-peak-shift/tools
 * Agent-scoped `peak_shift_*` tools registered on each agent's context.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/** Pure generic pending card (same shape dsh-schedule uses). */
function present(title, kind, rawInput) {
  return {
    card: 'generic',
    title,
    kind,
    ...(rawInput === void 0 ? {} : { rawInput }),
  };
}

/** Deterministic model content for every canonical value. */
function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', required: true, enum: ['active', 'paused'] },
    window: { type: 'string', required: true, enum: ['peak', 'off-peak'] },
    mode: { type: 'string', required: true },
    nextPeakAt: { type: 'string' },
    nextOffPeakAt: { type: 'string' },
    shiftedRequests: { type: 'number', required: true },
    savedEstimate: { type: 'number', required: true },
    currency: { type: 'string', required: true },
  },
};

const PAUSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', required: true, enum: ['paused', 'already-paused'] },
  },
};

const RESUME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', required: true, enum: ['active', 'already-active'] },
  },
};

const STATS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    shiftedRequests: { type: 'number', required: true },
    savedEstimate: { type: 'number', required: true },
    currency: { type: 'string', required: true },
    perMillion: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        input: { type: 'number', required: true },
        cacheRead: { type: 'number', required: true },
        cacheWrite: { type: 'number', required: true },
        output: { type: 'number', required: true },
      },
    },
    peakFactor: { type: 'number', required: true },
    offPeakFactor: { type: 'number', required: true },
  },
};

/**
 * Register all `peak_shift_*` tools in one agent scope.
 * @param {object} rootCtx - global service context (logging).
 * @param {object} agent - the live agent owning these tools.
 * @param {object} runtime - this agent's PeakShiftRuntime.
 * @returns {() => void} aggregate disposer.
 */
export function registerPeakShiftTools(rootCtx, agent, runtime) {
  // Some compositions (e.g. the web agent-preset plane) mount the agent's
  // tools per session and may not expose a registerable `tools` on the agent
  // scope at `agent/created`. Peak-shift must degrade gracefully there: the
  // pre-step gate keeps working, only the peak_shift_* helpers are absent.
  const tools = agent.ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    rootCtx.logger.warn(`peak-shift: tools service unavailable on agent scope; peak_shift_* tools skipped for ${agent.id}`);
    return () => {};
  }

  const disposers = [];

  disposers.push(tools.register(defineTool({
    name: 'peak_shift_status',
    description: "Report this agent's peak-shift state: current peak/off-peak window, pause state, next window transitions, and the cumulative estimated savings from requests shifted off-peak.",
    parameters: {},
    output: { schema: STATUS_SCHEMA, render: renderValue },
    async execute() {
      return runtime.statusView();
    },
    presentCall: () => present('Peak-shift status', 'read'),
  })));

  disposers.push(agent.ctx.tools.register(defineTool({
    name: 'peak_shift_pause',
    description: 'Manually pause this agent now, overriding window timing. It stays paused until peak_shift_resume or a restart clears the override.',
    parameters: {
      reason: {
        type: 'string',
        description: 'Optional note recorded in the runtime state.',
      },
    },
    output: { schema: PAUSE_SCHEMA, render: renderValue },
    async execute(args) {
      await runtime.manualPause(args.reason);
      return { state: 'paused' };
    },
    presentCall: (args) => present('Pause peak-shift', 'other', args.reason),
  })));

  disposers.push(agent.ctx.tools.register(defineTool({
    name: 'peak_shift_resume',
    description: 'Manually resume this agent now, clearing any manual pause override and releasing parked work when off-peak.',
    parameters: {},
    output: { schema: RESUME_SCHEMA, render: renderValue },
    async execute() {
      await runtime.manualResume();
      return { state: runtime.isPaused() ? 'already-active' : 'active' };
    },
    presentCall: () => present('Resume peak-shift', 'other'),
  })));

  disposers.push(agent.ctx.tools.register(defineTool({
    name: 'peak_shift_stats',
    description: 'Detailed cumulative peak-shift savings estimate and the price model used to compute it.',
    parameters: {},
    output: { schema: STATS_SCHEMA, render: renderValue },
    async execute() {
      return runtime.statsView();
    },
    presentCall: () => present('Peak-shift stats', 'read'),
  })));

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const dispose of disposers.reverse()) dispose();
  };
}
