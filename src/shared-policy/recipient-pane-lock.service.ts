import { AsyncLocalStorage } from 'node:async_hooks';
import {
  countHeldLocks,
  type HeldLock,
  isLockHeld,
  type LockRow,
  releaseLock,
  stillOwnsLock,
  tryTakeLock,
} from './lock-rows/lock-rows.ts';
import { PANE_LOCK_MAXIMUM_HOLD_MS, PaneLockTakenOverError } from './recipient-pane-lock-record.ts';
import { resolveThroneHome } from './throne-home.ts';

export { PANE_LOCK_MAXIMUM_HOLD_MS, PaneLockTakenOverError };

const PANE_LOCK_NAME_PREFIX = 'recipient-pane:';
const RETRY_INTERVAL_MS = 25;
const DEFAULT_LONG_WAIT_THRESHOLD_MS = 5_000;

export interface RecipientPaneLockOptions {
  throneHome?: string;
  longWaitThresholdMs?: number;
  takeOver?: (paneId: string) => Promise<void>;
}

export interface PendingRecipientPaneLockWait {
  paneId: string;
  waitingMs: number;
}

const pendingLongWaitStartedAtMsByPaneId = new Map<string, number>();

const paneLocksHeldByThisTask = new AsyncLocalStorage<ReadonlyMap<string, HeldLock>>();

function runHoldingPane<T>(paneId: string, held: HeldLock, action: () => Promise<T>): Promise<T> {
  const locks = new Map(paneLocksHeldByThisTask.getStore());
  locks.set(paneId, held);
  return paneLocksHeldByThisTask.run(locks, action);
}

export function getPendingLongRecipientPaneLockWaits(
  nowMs: number = Date.now(),
): PendingRecipientPaneLockWait[] {
  return [...pendingLongWaitStartedAtMsByPaneId.entries()].map(([paneId, startedAtMs]) => ({
    paneId,
    waitingMs: nowMs - startedAtMs,
  }));
}

export interface RecipientPaneLockDeps {
  env: NodeJS.ProcessEnv;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const REAL_RECIPIENT_PANE_LOCK_DEPS: RecipientPaneLockDeps = {
  env: process.env,
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds).unref(); }),
};

function throneHomeFor(options: RecipientPaneLockOptions, deps: RecipientPaneLockDeps): string {
  return options.throneHome ?? resolveThroneHome(deps.env);
}

function paneLockName(paneId: string): string {
  if (paneId.length === 0) throw new Error('recipient pane id must not be empty');
  return `${PANE_LOCK_NAME_PREFIX}${paneId}`;
}

export async function countInFlightRecipientPaneLocks(
  options: RecipientPaneLockOptions = {},
  deps: RecipientPaneLockDeps = REAL_RECIPIENT_PANE_LOCK_DEPS,
): Promise<number | null> {
  try {
    return countHeldLocks(throneHomeFor(options, deps), PANE_LOCK_NAME_PREFIX);
  } catch {
    return null;
  }
}

async function takeOverPane(
  paneId: string,
  takenOverFrom: LockRow,
  ageMs: number,
  options: RecipientPaneLockOptions,
): Promise<void> {
  console.warn(
    `recipient pane lock for ${paneId} taken over from process ${takenOverFrom.processId} after ${ageMs}ms`,
  );
  try {
    await options.takeOver?.(paneId);
  } catch (error) {
    console.warn(`forced Enter at takeover of ${paneId} refused: ${(error as Error).message}`);
  }
}

async function takeOrWait(
  paneId: string,
  options: RecipientPaneLockOptions,
  deps: RecipientPaneLockDeps,
): Promise<HeldLock> {
  const throneHome = throneHomeFor(options, deps);
  const name = paneLockName(paneId);
  const longWaitStartedAtMs = Date.now();
  const longWaitTimer = setTimeout(() => {
    pendingLongWaitStartedAtMsByPaneId.set(paneId, longWaitStartedAtMs);
    console.warn(
      `recipient pane lock for ${paneId} has been waiting ${Date.now() - longWaitStartedAtMs}ms ` +
      'to acquire (still pending)',
    );
  }, options.longWaitThresholdMs ?? DEFAULT_LONG_WAIT_THRESHOLD_MS);
  longWaitTimer.unref?.();
  try {
    for (;;) {
      const held = tryTakeLock(throneHome, name, PANE_LOCK_MAXIMUM_HOLD_MS, deps.now());
      if (held !== null) {
        if (held.takenOverFrom !== undefined) {
          await takeOverPane(paneId, held.takenOverFrom, held.takenAt - held.takenOverFrom.takenAt, options);
        }
        return held;
      }
      await deps.sleep(RETRY_INTERVAL_MS);
    }
  } finally {
    clearTimeout(longWaitTimer);
    pendingLongWaitStartedAtMsByPaneId.delete(paneId);
  }
}

export class RecipientPaneLockService {
  async confirmStillOwnsPaneLock(paneId: string): Promise<void> {
    const held = paneLocksHeldByThisTask.getStore()?.get(paneId);
    if (held === undefined) return;
    if (!stillOwnsLock(held)) throw new PaneLockTakenOverError(paneId);
  }

  async isHeldByAnotherSender(
    paneId: string,
    options: RecipientPaneLockOptions = {},
    deps: RecipientPaneLockDeps = REAL_RECIPIENT_PANE_LOCK_DEPS,
  ): Promise<boolean> {
    if (paneLocksHeldByThisTask.getStore()?.has(paneId) === true) return false;
    try {
      return isLockHeld(throneHomeFor(options, deps), paneLockName(paneId));
    } catch {
      return false;
    }
  }

  async withRecipientPaneLock<T>(
    paneId: string,
    action: () => Promise<T>,
    options: RecipientPaneLockOptions = {},
    deps: RecipientPaneLockDeps = REAL_RECIPIENT_PANE_LOCK_DEPS,
  ): Promise<T> {
    if (paneLocksHeldByThisTask.getStore()?.has(paneId) === true) return action();
    const held = await takeOrWait(paneId, options, deps);
    try {
      return await runHoldingPane(paneId, held, action);
    } finally {
      releaseLock(held);
    }
  }
}
