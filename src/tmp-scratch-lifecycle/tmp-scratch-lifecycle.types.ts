export interface ScratchDirHolder {
  pid: number;
  command: string | null;
}

/**
 * A once-per-sweep snapshot of every path a live process currently holds
 * (cwd or open file descriptor) under `/proc`. `reliable: false` means the
 * snapshot itself is incomplete or ambiguous (e.g. `/proc` unreadable, or a
 * genuinely unexpected read failure) — an unreliable index clears nothing,
 * so every directory falls through to a fresh per-directory holder check
 * instead of being wrongly trusted as unheld.
 */
export interface ScratchHolderIndex {
  reliable: boolean;
  heldPaths: ReadonlySet<string>;
}

export const KILL_OUTCOMES = {
  ALREADY_GONE: 'already-gone',
  TERMINATED: 'terminated',
  KILLED: 'killed',
  FAILED: 'failed',
} as const;

export type KillOutcome = (typeof KILL_OUTCOMES)[keyof typeof KILL_OUTCOMES];

export interface ScratchDirHolderKillResult {
  pid: number;
  outcome: KillOutcome;
}

export const SCRATCH_DIR_REMOVAL_OUTCOMES = {
  REMOVED: 'removed',
  SKIPPED_LIVE: 'skipped-live',
  SKIPPED_TOO_YOUNG: 'skipped-too-young',
} as const;

export type ScratchDirRemovalOutcome =
  (typeof SCRATCH_DIR_REMOVAL_OUTCOMES)[keyof typeof SCRATCH_DIR_REMOVAL_OUTCOMES];

export interface ScratchDirRemovalResult {
  dirPath: string;
  outcome: ScratchDirRemovalOutcome;
}
