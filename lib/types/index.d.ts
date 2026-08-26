/**
 * dsh-peak-shift public types (consumed by dsh loader / TS tooling).
 * The runtime is plain ESM JS; this file describes the plugin contract.
 */
import type { Context } from '@deepseek-ai/cordis';

export interface PeakWindowEntry {
  /** `mon`..`sun` or 0..6; empty means every day. */
  days?: string[] | number[];
  /** `HH:MM-HH:MM` ranges; an end no later than its start crosses midnight. */
  ranges: string[];
}

export interface PeakShiftConfig {
  targets?: Array<'goal' | 'headless' | 'subagent' | 'interactive'>;
  windows?: {
    zone?: string;
    peak?: PeakWindowEntry[];
  };
  leadMinutes?: number;
  enforcement?: 'gate' | 'cancel';
  mode?: 'park' | 'defer' | 'off';
  pricing?: {
    currency?: string;
    perMillion?: {
      input?: number;
      cacheRead?: number;
      cacheWrite?: number;
      output?: number;
    };
    peakFactor?: number;
    offPeakFactor?: number;
  };
  startPolicy?: 'park' | 'run';
  pollIntervalMs?: number;
  stateDir?: string;
}

export declare const name: string;
export declare const inject: string[];
export declare const Config: import('@deepseek-ai/schemastery').Schema<PeakShiftConfig>;
export declare function apply(ctx: Context, config: PeakShiftConfig): void;
