import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import {
  readSupervisorWait,
  SUPERVISOR_WAIT_STEPS,
  type SupervisorWait,
} from '../supervisor-wait/read-supervisor-wait.ts';
import { ACCEPTANCE_DATA } from '../agentdata/acceptance-data.service.ts';
import { recordClaimSeen } from '../supervisor-wait/claim-seen.ts';
import type { ClearedChildren } from './dependency-cleared-wake.ts';
import type { LastMessageTagState } from './idle-pane-tag-classification.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { buildClaimReminderMessage, buildClaimWakeMessage } from './message.ts';
import { NO_IDLING_SENDER, NO_IDLING_SUBMIT_TIMEOUT_MS, writeErr, writeOut } from './no-idling-notify-guard.ts';
import { NO_IDLING_REGENT_NAME } from './idle-family.ts';
import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';

export const GO_AHEAD_CLAIM_LIMIT_MS = 10 * 60_000;

const NOTICES_BASENAME = 'supervisor-wait-notices.json';

export interface ClaimWaitSweep {
  readonly deps: NoIdlingDependencies;
  readonly lastMessageTags: ReadonlyMap<string, LastMessageTagState>;
  readonly supervisorNames: ReadonlyMap<string, string>;
  readonly dataDir: string;
  readonly nowMs: number;
  readonly recordNotices: boolean;
  readonly clearedDependencyWakes: ReadonlyMap<string, ClearedChildren>;
}

function hasClaimed(tag: LastMessageTagState | undefined): boolean {
  return tag?.kind === 'reapable' || tag?.kind === 'reapable-failed';
}

export function isWaitingBeforeItMayClaim(wait: SupervisorWait | undefined, nowMs: number): boolean {
  if (wait?.waiting !== true) return false;
  if (wait.step === SUPERVISOR_WAIT_STEPS.GO_AHEAD_SENT_AWAITING_CLAIM) {
    return nowMs - wait.since.getTime() < GO_AHEAD_CLAIM_LIMIT_MS;
  }
  return (
    wait.step === SUPERVISOR_WAIT_STEPS.DONE_AWAITING_ACCEPTANCE ||
    wait.step === SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD
  );
}

export async function isAcceptedLiveAgent(entry: AgentStatusesRosterEntry, dataDir: string): Promise<boolean> {
  if (entry.lifecycle !== 'live') return false;
  return (await ACCEPTANCE_DATA.read(entry.name, dataDir).catch(() => null)) !== null;
}

export async function readSupervisorWaits(
  roster: readonly AgentStatusesRosterEntry[],
  dataDir: string,
): Promise<ReadonlyMap<string, SupervisorWait>> {
  const waits = new Map<string, SupervisorWait>();
  for (const entry of roster) {
    if (entry.lifecycle === 'live') {
      waits.set(entry.name, await readSupervisorWait({ agentName: entry.name, dataDir }));
    }
  }
  return waits;
}

async function readSentNotices(agentName: string, dataDir: string): Promise<string[]> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, agentName, NOTICES_BASENAME), 'utf8')) as string[];
  } catch {
    return [];
  }
}

async function sendOnce(
  sweep: ClaimWaitSweep,
  owner: string,
  recipient: string,
  noticeKey: string,
  prompt: string | undefined,
): Promise<boolean> {
  const sent = await readSentNotices(owner, sweep.dataDir);
  if (sent.includes(noticeKey)) return false;
  if (prompt !== undefined) {
    try {
      const target = await sweep.deps.resolveAgent(recipient);
      await sweep.deps.submitToAgent(target, NO_IDLING_SENDER, prompt, {
        key: `no-idling-${noticeKey}:${owner}`,
        composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
      });
    } catch (error) {
      writeErr(sweep.deps, `no-idling: ${noticeKey} for ${owner} failed: ${(error as Error).message}\n`);
      return false;
    }
  }
  if (sweep.recordNotices) {
    await mkdir(path.join(sweep.dataDir, owner), { recursive: true });
    await writeFile(
      path.join(sweep.dataDir, owner, NOTICES_BASENAME),
      `${JSON.stringify([...sent, noticeKey])}\n`,
    );
  }
  return prompt !== undefined;
}

function wasAccepted(
  wait: SupervisorWait | undefined,
): wait is Extract<SupervisorWait, { waiting: true }> {
  return wait?.waiting === true && wait.step !== SUPERVISOR_WAIT_STEPS.DONE_AWAITING_ACCEPTANCE;
}

function wasWokenByDependencyClearedWake(sweep: ClaimWaitSweep, supervisor: string, child: string): boolean {
  return (
    sweep.clearedDependencyWakes.get(supervisor)?.reapable.some((name) => sameAgentName(name, child)) === true
  );
}

export async function notifySupervisorsOfClaims(
  sweep: ClaimWaitSweep,
  waits: ReadonlyMap<string, SupervisorWait>,
): Promise<void> {
  for (const [child, tag] of sweep.lastMessageTags) {
    const supervisor = sweep.supervisorNames.get(child);
    const wait = waits.get(child);
    if (
      !hasClaimed(tag) ||
      supervisor === undefined ||
      sameAgentName(supervisor, NO_IDLING_REGENT_NAME) ||
      !wasAccepted(wait)
    ) {
      continue;
    }
    if (sweep.recordNotices) await recordClaimSeen(child, sweep.dataDir, new Date(sweep.nowMs));
    const noticeKey = `claim-wake:${wait.since.toISOString()}`;
    const prompt = wasWokenByDependencyClearedWake(sweep, supervisor, child)
      ? undefined
      : buildClaimWakeMessage(child);
    if (await sendOnce(sweep, child, supervisor, noticeKey, prompt)) {
      writeOut(sweep.deps, `no-idling: told ${supervisor} that ${child} has claimed\n`);
    }
  }
}

export async function remindAgentsToClaim(
  sweep: ClaimWaitSweep,
  waits: ReadonlyMap<string, SupervisorWait>,
): Promise<void> {
  for (const [agent, wait] of waits) {
    if (
      wait.waiting !== true ||
      wait.step !== SUPERVISOR_WAIT_STEPS.GO_AHEAD_SENT_AWAITING_CLAIM ||
      sweep.lastMessageTags.get(agent)?.kind !== 'unmarked' ||
      !isWaitingBeforeItMayClaim(wait, sweep.nowMs)
    ) {
      continue;
    }
    const noticeKey = `claim-reminder:${wait.since.toISOString()}`;
    if (await sendOnce(sweep, agent, agent, noticeKey, buildClaimReminderMessage(wait.supervisor))) {
      writeOut(sweep.deps, `no-idling: reminded ${agent} to publish its reapability claim\n`);
    }
  }
}

export async function handleClaimWaits(
  sweep: ClaimWaitSweep,
  waits: ReadonlyMap<string, SupervisorWait>,
): Promise<void> {
  await notifySupervisorsOfClaims(sweep, waits);
  await remindAgentsToClaim(sweep, waits);
}
