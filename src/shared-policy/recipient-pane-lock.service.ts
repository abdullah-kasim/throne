import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readdir,
  type FileHandle,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

export const RECIPIENT_PANE_LOCK_DIRECTORY_ENV = 'THRONE_RECIPIENT_LOCK_DIR';
const LOCK_HOLDER_EXIT_TIMEOUT_MS = 1_000;
const LOCK_FILENAME_SUFFIX = '.lock';
// Below the acquisition ceiling so a stalled wait is reported while it is
// still pending, not only after it has already been failed outright.
const DEFAULT_LONG_WAIT_THRESHOLD_MS = 5_000;
// This lock guards the right to send ONE message; a single delivery (write,
// then Enter until the composer empties) is seconds-scale by nature, so a
// wait still unresolved on the order of 10 seconds means the holder is
// broken, not slow. Losing the lock at that point is the correct outcome,
// not a failure to prevent — unlike the separately-policied full-suite
// lock, this pane lock never renews or waits longer than this ceiling.
const DEFAULT_ACQUISITION_CEILING_MS = 10_000;

export interface RecipientPaneLockOptions {
  lockDirectory?: string;
  flockExecutable?: string;
  longWaitThresholdMs?: number;
  acquisitionCeilingMs?: number;
}

/**
 * Thrown when a recipient-pane lock acquisition is still pending once it
 * crosses its acquisition ceiling. Distinguishable from every other
 * rejection `withRecipientPaneLock` can produce so a caller can classify it
 * as a stalled-holder failure rather than an ordinary delivery error.
 */
export class RecipientPaneLockAcquisitionCeilingExceededError extends Error {
  constructor(paneId: string, ceilingMs: number, waitedMs: number) {
    super(
      `recipient pane lock for ${paneId} was still waiting to acquire after ${waitedMs}ms, ` +
      `past its ${ceilingMs}ms acquisition ceiling`,
    );
    this.name = 'RecipientPaneLockAcquisitionCeilingExceededError';
  }
}

export interface PendingRecipientPaneLockWait {
  paneId: string;
  waitingMs: number;
}

const pendingLongWaitStartedAtMsByPaneId = new Map<string, number>();

/**
 * Non-blockingly reports every recipient-pane lock acquisition that has been
 * waiting past its observability threshold and has NOT yet resolved — a
 * snapshot of stalls still in progress, not a log of ones that already
 * finished. Companion to `countInFlightRecipientPaneLocks`: that function
 * counts locks currently HELD; this one reports acquisitions still WAITING
 * long enough to be worth a supervisor's attention.
 */
export function getPendingLongRecipientPaneLockWaits(
  nowMs: number = Date.now(),
): PendingRecipientPaneLockWait[] {
  return [...pendingLongWaitStartedAtMsByPaneId.entries()].map(([paneId, startedAtMs]) => ({
    paneId,
    waitingMs: nowMs - startedAtMs,
  }));
}

export interface RecipientPaneLockDeps {
  chmod: typeof chmod;
  mkdir: typeof mkdir;
  open: typeof open;
  readdir: typeof readdir;
  homedir: typeof os.homedir;
  env: NodeJS.ProcessEnv;
  acquirePathLock(lockPath: string, flockExecutable: string): Promise<() => Promise<void>>;
  isPaneLockCurrentlyHeld(lockPath: string, flockExecutable: string): Promise<boolean>;
}

function acquirePathLock(lockPath: string, flockExecutable: string): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const child = spawn(flockExecutable, [
      '--exclusive', lockPath, 'sh', '-c', 'printf ready >&4; cat >/dev/null',
    ], {
      stdio: ['pipe', 'ignore', 'pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    const ready = child.stdio[4] as Readable | null;
    ready?.setEncoding('utf8');
    ready?.once('data', () => {
      settled = true;
      resolve(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((release) => {
          const timeout = setTimeout(() => child.kill('SIGKILL'), LOCK_HOLDER_EXIT_TIMEOUT_MS);
          timeout.unref();
          child.once('close', () => {
            clearTimeout(timeout);
            release();
          });
          child.stdin?.end();
        });
      });
    });
    child.once('error', (error) => {
      if (!settled) reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 0) return reject(new Error(`${flockExecutable} exited before acquiring the recipient pane lock`));
      const detail = stderr.trim();
      reject(new Error(
        `${flockExecutable} could not acquire the recipient pane lock` +
        `${signal === null ? ` (exit ${code ?? 'unknown'})` : ` (${signal})`}` +
        `${detail === '' ? '' : `: ${detail}`}`,
      ));
    });
  });
}

/**
 * Non-blockingly probes whether a lock file is currently held, without ever
 * waiting for it and without leaving anything locked behind: a `flock
 * --nonblock` attempt that acquires immediately proves nothing else holds it
 * (and releases it again on exit, since the probe itself keeps nothing);
 * `flock --nonblock`'s dedicated exit code 1 proves something else does.
 */
function isPaneLockCurrentlyHeld(lockPath: string, flockExecutable: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(flockExecutable, ['--nonblock', '--exclusive', lockPath, 'true']);
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) return resolve(false);
      if (code === 1) return resolve(true);
      reject(new Error(`${flockExecutable} --nonblock probe exited ${code ?? 'unknown'}`));
    });
  });
}

const REAL_DEPS: RecipientPaneLockDeps = {
  chmod,
  mkdir,
  open,
  readdir,
  homedir: os.homedir,
  env: process.env,
  acquirePathLock,
  isPaneLockCurrentlyHeld,
};

function lockDirectory(options: RecipientPaneLockOptions, deps: RecipientPaneLockDeps): string {
  return options.lockDirectory ?? deps.env[RECIPIENT_PANE_LOCK_DIRECTORY_ENV] ??
    path.join(deps.homedir(), '.throne', 'locks', 'recipient-panes');
}

export function recipientPaneLockFilename(paneId: string): string {
  if (paneId.length === 0) throw new Error('recipient pane id must not be empty');
  return `${createHash('sha256').update(paneId, 'utf8').digest('hex')}.lock`;
}

async function closeWithoutChangingOutcome(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try { await handle.close(); } catch { return; }
}

/**
 * Non-blockingly reports how many recipient-pane deliveries are in flight
 * right now, without waiting on any of them: `0` when no delivery has ever
 * locked a pane (a directory that has never been created) or none of the
 * known lock files is currently held, a positive count for each lock file
 * currently held by another process, and `null` when the probe itself could
 * not be carried out (distinct from a directory that legitimately doesn't
 * exist yet). This is a snapshot, not a wait: a pane can lock the instant
 * after this resolves, and callers must treat that gap as accepted, not a
 * defect to close here.
 */
export async function countInFlightRecipientPaneLocks(
  options: RecipientPaneLockOptions = {},
  deps: RecipientPaneLockDeps = REAL_DEPS,
): Promise<number | null> {
  const directory = lockDirectory(options, deps);
  let entries: string[];
  try {
    entries = await deps.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    return null;
  }
  const lockFilenames = entries.filter((name) => name.endsWith(LOCK_FILENAME_SUFFIX));
  const flockExecutable = options.flockExecutable ?? 'flock';
  try {
    const heldFlags = await Promise.all(
      lockFilenames.map((name) => deps.isPaneLockCurrentlyHeld(path.join(directory, name), flockExecutable)),
    );
    return heldFlags.filter(Boolean).length;
  } catch {
    return null;
  }
}

/**
 * Rejects once real elapsed time since `startedAtMs` reaches `ceilingMs`,
 * re-checking `Date.now()` on every tick rather than trusting a single
 * timer's delay to be accurate — the acquisition ceiling is a correctness
 * bound on genuine wall-clock wait time, so it must hold even where a test
 * harness rewrites `setTimeout` delays for its own hermetic speed.
 */
function rejectWhenAcquisitionCeilingExceeded(
  paneId: string,
  startedAtMs: number,
  ceilingMs: number,
): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const promise = new Promise<never>((_, reject) => {
    const check = () => {
      if (cancelled) return;
      const waitedMs = Date.now() - startedAtMs;
      if (waitedMs >= ceilingMs) {
        reject(new RecipientPaneLockAcquisitionCeilingExceededError(paneId, ceilingMs, waitedMs));
        return;
      }
      timer = setTimeout(check, ceilingMs - waitedMs);
      timer.unref?.();
    };
    check();
  });
  return { promise, cancel: () => { cancelled = true; clearTimeout(timer); } };
}

/**
 * Wraps `deps.acquirePathLock` so a wait crossing `longWaitThresholdMs`
 * becomes observable — logged and queryable via
 * `getPendingLongRecipientPaneLockWaits` — while it is still pending, not
 * only after it resolves; and so a wait crossing `acquisitionCeilingMs`
 * fails outright with `RecipientPaneLockAcquisitionCeilingExceededError`.
 * Acquisition semantics for a wait that resolves within the ceiling
 * (exclusive, eventually granted, FIFO-consistent) are unchanged. A lock
 * that is acquired only after the ceiling already rejected it is released
 * immediately rather than kept — nothing is left holding a lock nobody is
 * waiting for anymore.
 */
async function acquirePathLockObservingLongWaits(
  paneId: string,
  targetPath: string,
  options: RecipientPaneLockOptions,
  deps: RecipientPaneLockDeps,
): Promise<() => Promise<void>> {
  const startedAtMs = Date.now();
  const acquisition = deps.acquirePathLock(targetPath, options.flockExecutable ?? 'flock');
  const longWaitTimer = setTimeout(() => {
    pendingLongWaitStartedAtMsByPaneId.set(paneId, startedAtMs);
    console.warn(
      `recipient pane lock for ${paneId} has been waiting ${Date.now() - startedAtMs}ms ` +
      'to acquire (still pending)',
    );
  }, options.longWaitThresholdMs ?? DEFAULT_LONG_WAIT_THRESHOLD_MS);
  longWaitTimer.unref?.();
  const ceiling = rejectWhenAcquisitionCeilingExceeded(
    paneId,
    startedAtMs,
    options.acquisitionCeilingMs ?? DEFAULT_ACQUISITION_CEILING_MS,
  );
  try {
    return await Promise.race([acquisition, ceiling.promise]);
  } catch (error) {
    acquisition.then((release) => release()).catch(() => {});
    throw error;
  } finally {
    clearTimeout(longWaitTimer);
    ceiling.cancel();
    pendingLongWaitStartedAtMsByPaneId.delete(paneId);
  }
}

/** Owns kernel-backed recipient pane exclusion for every Nest command consumer. */
export class RecipientPaneLockService {
  readonly recipientPaneLockFilename = recipientPaneLockFilename;

  async withRecipientPaneLock<T>(
    paneId: string,
    action: () => Promise<T>,
    options: RecipientPaneLockOptions = {},
    deps: RecipientPaneLockDeps = REAL_DEPS,
  ): Promise<T> {
    const directory = lockDirectory(options, deps);
    let handle: FileHandle | undefined;
    let release: (() => Promise<void>) | undefined;
    const targetPath = path.join(directory, recipientPaneLockFilename(paneId));
    try {
      await deps.mkdir(directory, { recursive: true, mode: 0o700 });
      await deps.chmod(directory, 0o700);
      handle = await deps.open(targetPath, 'a+', 0o600);
      await handle.chmod(0o600);
      await closeWithoutChangingOutcome(handle);
      handle = undefined;
      release = await acquirePathLockObservingLongWaits(paneId, targetPath, options, deps);
      return await action();
    } finally {
      try {
        await release?.();
      } finally {
        await closeWithoutChangingOutcome(handle);
      }
    }
  }
}
