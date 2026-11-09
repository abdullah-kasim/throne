import { spawn } from 'node:child_process';
import { sameAgentName, type HerdrAgent } from '../herdr/herdr-identity-contracts.ts';
import { paneHasLiveHarnessProcess } from '../herdr/herdr-process-detection.ts';
import { RESURRECT_LOCK_STALE_MS, refreshResurrectLock } from '../regent-state/regent-resurrect-lock.ts';
import { REGENT_DIR } from '../regent-state/regent-state.service.ts';
import { isRegent, regentSkippedForHeldLock, relaunchAgent } from '../restart-harnesses/restart-harnesses-relaunch.ts';
import {
  REAL_DEPS,
  type RestartHarnessesDeps,
  type RestartOutcome,
} from '../restart-harnesses/restart-harnesses-runtime.ts';

const LOCK_REFRESHES_PER_STALE_WINDOW = 5;
const RESTART_STOPPED_EXIT_CODE = 1;

export const RESURRECT_LOCK_REFRESH_MS = RESURRECT_LOCK_STALE_MS / LOCK_REFRESHES_PER_STALE_WINDOW;

export type ResumeAfterRestartDeps = RestartHarnessesDeps & {
  refreshRegentRestartLock: (token: string) => Promise<void>;
};

export const REAL_RESUME_AFTER_RESTART_DEPS: ResumeAfterRestartDeps = {
  ...REAL_DEPS,
  refreshRegentRestartLock: (token) => refreshResurrectLock(REGENT_DIR, token),
};

function regentLast(agents: readonly HerdrAgent[]): HerdrAgent[] {
  return [...agents.filter((agent) => !isRegent(agent)), ...agents.filter(isRegent)];
}

function renderResumeOutcome(outcome: RestartOutcome): string {
  return `repair: ${outcome.verdict} "${outcome.name}" — ${outcome.detail}\n`;
}

export function agentsTheRestartEnded(
  snapshot: readonly HerdrAgent[],
  liveAgents: readonly HerdrAgent[],
): HerdrAgent[] {
  const liveSessions = new Set(liveAgents.map((agent) => agent.sessionId));
  return snapshot.filter((agent) => agent.sessionId === undefined || !liveSessions.has(agent.sessionId));
}

export async function whileHoldingResurrectLock<Result>(
  deps: ResumeAfterRestartDeps,
  work: (lockIsHeld: boolean) => Promise<Result>,
): Promise<Result> {
  const lockToken = await deps.acquireRegentRestartLock();
  const lockRefresher =
    lockToken === null
      ? undefined
      : setInterval(() => void deps.refreshRegentRestartLock(lockToken), RESURRECT_LOCK_REFRESH_MS);
  try {
    return await work(lockToken !== null);
  } finally {
    clearInterval(lockRefresher);
    if (lockToken !== null) await deps.releaseRegentRestartLock(lockToken);
  }
}

function restartStepsSucceed(restartSteps: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    spawn('bash', ['-c', restartSteps], { stdio: 'inherit' })
      .on('error', reject)
      .on('close', (exitCode) => resolve(exitCode === 0));
  });
}

export function restartServerThenRepairCourt(
  restartSteps: string,
  repairCourt: (lockIsHeld: boolean) => Promise<number>,
  deps: ResumeAfterRestartDeps,
): Promise<number> {
  return whileHoldingResurrectLock(deps, async (lockIsHeld) =>
    (await restartStepsSucceed(restartSteps)) ? repairCourt(lockIsHeld) : RESTART_STOPPED_EXIT_CODE,
  );
}

export async function resumeAgentsAfterServerRestart(
  agents: readonly HerdrAgent[],
  lockIsHeld: boolean,
  deps: ResumeAfterRestartDeps,
): Promise<RestartOutcome[]> {
  const outcomes: RestartOutcome[] = [];
  for (const agent of regentLast(agents)) {
    const outcome = !lockIsHeld && isRegent(agent) ? regentSkippedForHeldLock(agent) : await relaunchAgent(agent, deps);
    (outcome.verdict === 'failed' ? deps.warn : deps.log)(renderResumeOutcome(outcome));
    outcomes.push(outcome);
  }
  return outcomes;
}

export async function namesWithoutLiveHarness(
  snapshot: readonly HerdrAgent[],
  deps: Pick<RestartHarnessesDeps, 'listAgents' | 'getPaneProcessInfo'>,
): Promise<string[]> {
  const liveAgents = await deps.listAgents();
  const withoutHarness: string[] = [];
  for (const agent of snapshot) {
    const pane = liveAgents.find((candidate) => sameAgentName(candidate.name, agent.name));
    if (pane === undefined || !paneHasLiveHarnessProcess(await deps.getPaneProcessInfo(pane.paneId))) {
      withoutHarness.push(agent.name!);
    }
  }
  return withoutHarness;
}
