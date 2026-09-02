import {
  KILL_OUTCOMES,
  type ScratchDirHolder,
  type ScratchDirHolderKillResult,
} from './tmp-scratch-lifecycle.types.ts';

const GRACEFUL_SIGNAL = 'SIGTERM';
const ESCALATED_SIGNAL = 'SIGKILL';
const SIGNAL_WAIT_MS = 500;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user can't signal it; any
    // other error (ESRCH) means it's gone.
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone or unsignalable; the exists-check after this call is
    // the source of truth, not this send.
  }
}

async function killScratchDirHolder(
  holder: ScratchDirHolder,
): Promise<ScratchDirHolderKillResult> {
  if (!processExists(holder.pid)) {
    return { pid: holder.pid, outcome: KILL_OUTCOMES.ALREADY_GONE };
  }
  trySignal(holder.pid, GRACEFUL_SIGNAL);
  await sleep(SIGNAL_WAIT_MS);
  if (!processExists(holder.pid)) {
    return { pid: holder.pid, outcome: KILL_OUTCOMES.TERMINATED };
  }
  trySignal(holder.pid, ESCALATED_SIGNAL);
  await sleep(SIGNAL_WAIT_MS);
  return {
    pid: holder.pid,
    outcome: processExists(holder.pid)
      ? KILL_OUTCOMES.FAILED
      : KILL_OUTCOMES.KILLED,
  };
}

/**
 * Terminates exactly the given holders — never any other pid — with a
 * graceful signal first, then an escalated one after a bounded wait.
 */
export async function killScratchDirHolders(
  holders: readonly ScratchDirHolder[],
): Promise<ScratchDirHolderKillResult[]> {
  return Promise.all(holders.map((holder) => killScratchDirHolder(holder)));
}
