// Shared types, tick/text constants, and output-sink helpers for the
// keep-going heartbeat/watchdog. Every other keep-going-sweep module imports
// its contract from here rather than redeclaring it, so the dependency-bag
// shape (`KeepGoingDependencies`) and the herdr agent shape (`HerdrAgent`)
// have exactly one definition.

import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { FamilyRecoverySummary, StallEvidence } from './keep-going-stalls.ts';
import type { SubmitToAgentOptions } from '../herdr/herdr-send.types.ts';
import type {
  RegentFenceAction,
  RegentFenceReason,
} from '../regent-fencing/decide-regent-fence-action.ts';

export interface HerdrAgent {
  readonly agent: string;
  readonly name?: string;
  readonly agentStatus: 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
  readonly cwd: string;
  readonly focused: boolean;
  readonly paneId: string;
  readonly tabId: string;
  readonly terminalId: string;
}

export const DESIRED_STATES = { RUNNING: 'running', DISMISSED: 'dismissed' } as const;
export type DesiredState = (typeof DESIRED_STATES)[keyof typeof DESIRED_STATES];

export interface ThrottleBand {
  readonly name: string;
  readonly minIntervalMs: number;
  readonly advisory: string;
}

export interface ThrottleEvaluation {
  readonly band: ThrottleBand;
  readonly shouldNudge: boolean;
  readonly signal: { readonly status: string };
}

export const REGENT_NAME = 'Regent';
export const GENERAL_NUDGE_TEXT =
  'continue, merge any completed changes and continue any pending work';
export const KEEP_GOING_TICK_MINUTES = 30;
export const KEEP_GOING_TICK_MS = KEEP_GOING_TICK_MINUTES * 60 * 1000;
export const UNTHROTTLED_EVALUATION: ThrottleEvaluation = {
  band: { name: 'NORMAL', minIntervalMs: 0, advisory: '' },
  shouldNudge: true,
  signal: { status: 'unknown' },
};

/**
 * Injectable seam over the herdr layer + the regent-state primitives — defaults
 * to the real functions; tests supply stubs so every branch (dismissed / live /
 * resurrect / explicit target) is provable without shelling out to real herdr
 * or touching the real filesystem.
 */
export interface KeepGoingDependencies {
  resolveAgent: (name: string) => Promise<HerdrAgent>;
  findLiveRegent: () => Promise<HerdrAgent | null>;
  readDesiredState: () => Promise<DesiredState>;
  resurrectRegent: () => Promise<unknown>;
  submitToAgent: (
    target: HerdrAgent,
    sender: string,
    prompt: string,
    options?: SubmitToAgentOptions,
  ) => Promise<unknown>;
  evaluateThrottle: (harness: string) => Promise<ThrottleEvaluation>;
  now: () => Date;
  getRoster?: (root: string) => Promise<AgentStatusesRosterEntry[]>;
  readStallEvidence?: (
    roster: readonly AgentStatusesRosterEntry[],
    nowMs: number,
    dataDir?: string,
  ) => Promise<StallEvidence>;
  resolveHeartbeatRoot?: () => Promise<string>;
  /**
   * Decides whether the live Regent is wedged and should be fenced. Reads
   * the kill switch itself and no-ops without touching disk when it is off
   * -- the default -- so this stays a no-op read for every existing caller
   * that doesn't override it.
   */
  evaluateRegentFence?: () => Promise<RegentFenceAction>;
  /** Composes the dismiss/summon/ledger/notify sequence for a `fence`
   *  verdict. Defaults to the real orchestration; tests inject a fake to
   *  assert call order without touching real herdr/filesystem state. */
  runRegentFenceOrchestration?: (reason: RegentFenceReason) => Promise<void>;
  /**
   * Optional output sinks, defaulting to `process.stdout.write`/
   * `process.stderr.write` when absent. Every write in this file goes
   * through `writeOut`/`writeErr` below instead of the process streams
   * directly, so the REST route handler can capture a manual trigger's
   * output into its response without touching the real process streams --
   * required because `throne-backend` is a single long-lived process
   * hosting other workers that also write to those streams concurrently.
   */
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function writeOut(deps: KeepGoingDependencies, text: string): void {
  (deps.stdout ?? ((t: string) => process.stdout.write(t)))(text);
}

export function writeErr(deps: KeepGoingDependencies, text: string): void {
  (deps.stderr ?? ((t: string) => process.stderr.write(t)))(text);
}

export function sameAgentName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
