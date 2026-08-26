/**
 * @module dsh-peak-shift
 * Pause long-running dsh agents during DeepSeek peak-priced hours and resume
 * them at off-peak, saving token costs.
 *
 * Default window rule (DeepSeek billing): peak = Beijing time Mon–Fri
 * 09:00–12:00 and 14:00–18:00; everything else (including weekends) is the
 * off-peak half-price window.
 */

import z from '@deepseek-ai/schemastery';
import { createWindowPolicy } from './windows.js';
import { PeakShiftRuntime } from './runtime.js';
import { registerPeakShiftTools } from './tools.js';

/** Cordis function-plugin name used by loader diagnostics. */
export const name = 'peak-shift';
/** Services required before this plugin loads. `goals` stays optional. */
export const inject = ['agents', 'sessions', 'tools', 'timer'];

const DEFAULT_WINDOWS = {
  zone: 'Asia/Shanghai',
  peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: ['09:00-12:00', '14:00-18:00'] }],
};

/** Schemastery validation for {@link Config}. */
export const Config = z.object({
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
  const policy = createWindowPolicy(config.windows);
  const goals = optionalService(ctx, 'goals');
  const headless = optionalService(ctx, 'headlessStartup') !== undefined;
  const runtimes = new Map();

  ctx.on('agent/created', ({ agent }) => {
    if (runtimes.has(agent)) return;
    // Fail-safe: any peak-shift setup error is contained and logged so agent
    // creation / publication is never broken by this plugin.
    let runtime;
    try {
      runtime = new PeakShiftRuntime(ctx, config, agent, goals, policy, { headless });
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
      Promise.resolve(entry.cleanup()).catch(() => {});
    }
  });

  const stopPoll = ctx.interval(() => poll(), config.pollIntervalMs);
  function poll() {
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
