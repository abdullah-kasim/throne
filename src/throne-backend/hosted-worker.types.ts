/**
 * The one shared registration shape every job hosted inside `throne-backend`
 * uses. Adding a new worker means adding one more entry to
 * `HOSTED_WORKERS`, never inventing a bespoke registration mechanism.
 *
 * A `cron` worker fires `runOnce()` on its own schedule; a `long-lived`
 * worker owns its own loop and is started once at boot with a `shouldStop`
 * hook the registrar can use to ask it to stop.
 */
export interface CronHostedWorker {
  readonly kind: "cron";
  readonly workerName: string;
  readonly cronExpression: string;
  runOnce(): Promise<void>;
}

/**
 * `ready`, when present, is a promise that resolves once this worker has
 * reached its own definition of "ready to serve" (for the transport route
 * dispatcher: the socket is bound and `listen()`'s callback has fired) —
 * never the worker's entire lifetime, which for a long-lived worker never
 * ends on its own. A worker with no genuine readiness condition of its own
 * simply omits `ready`, and the registrar does not wait on it.
 */
export interface LongLivedHostedWorker {
  readonly kind: "long-lived";
  readonly workerName: string;
  readonly ready?: Promise<void>;
  start(shouldStop: () => boolean): Promise<void>;
}

/**
 * The third registration shape: a supervised **external** child process
 * (spawned and monitored, never called in-process) — the seam a future
 * herdr-remote relay needs, potentially reading its own env file the
 * registrar must never log or echo. No such worker is implemented by this
 * slice; this type and the registrar's handling of it exist only to prove
 * the mechanism isn't closed off to a third kind.
 */
export interface SupervisedProcessHostedWorker {
  readonly kind: "supervised-process";
  readonly workerName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type HostedWorker =
  | CronHostedWorker
  | LongLivedHostedWorker
  | SupervisedProcessHostedWorker;

export const HOSTED_WORKERS = Symbol("HOSTED_WORKERS");
