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
    model?: 'flash' | 'pro' | 'custom';
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
  /**
   * Settings namespace (profile entry id) the modern settings control plane
   * addresses. Empty = derive from the loader entry id, then `peak-shift`.
   * Only needed when the plugin is mounted under a non-default entry id.
   */
  settingsNamespace?: string;
  /**
   * One-shot control channel shared by the web card and the host
   * (`resume:<agentId>` or `resume-all`). Not user configuration.
   */
  commands?: string;
}

export declare const name: string;
export declare const inject: string[];
/**
 * The plugin Config schema. On dsh ≥ 0.1.7-rc.2 the settings-managed fields
 * (`enabled`, `windows`, `leadMinutes`, `pricing`, `commands`) are marked
 * `.volatile()` so the settings service can project them into a live form;
 * on older schemastery they stay plain.
 */
export declare const Config: import('@deepseek-ai/schemastery').Schema<PeakShiftConfig>;
/** Legacy `$DSH_HOME/settings.yaml` namespace (≤ 0.1.1-rc.2). */
export declare const SETTINGS_NAMESPACE: string;
export declare function apply(ctx: Context, config: PeakShiftConfig): void;
