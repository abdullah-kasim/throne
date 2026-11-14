import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import { NO_IDLING_SENDER, NO_IDLING_SUBMIT_TIMEOUT_MS } from '../no-idling/no-idling-notify-guard.ts';
import { formatDuration } from '../process-inspection/process-age.ts';
import {
  HARNESS_BACKGROUND_WORK_KINDS,
  shortenedCommand,
} from '../process-inspection/harness-background-work.ts';
import { MessageQueueWorkItemState } from '../message-queue/message-queue-work-item-state.ts';
import { NOT_SENT_FAILURE_PREFIX, UNADDRESSABLE_RECIPIENT_FAILURE_PREFIX } from '../throne-work/message-delivery-retry-policy.ts';
import { THRONE_DATA_DIR } from '../shared-policy/throne-home.ts';
import { DEFAULT_REMIND_IN_MINUTES, LONGEST_REMIND_IN_MINUTES, SHORTEST_REMIND_IN_MINUTES } from '../agentdata/agent-state.service.ts';
import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';

export const OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS = DEFAULT_REMIND_IN_MINUTES * 60_000;

export interface WatchedProcess {
  readonly pid: number;
  readonly startedAt?: number;
  readonly command: string;
}

export interface WakeProgress {
  readonly remindersSent?: number;
  readonly wokenForNothingRunning?: boolean;
}

export interface UndeliveredWake {
  readonly key: string;
  readonly progressBeforeTheWake: WakeProgress;
}

export interface RememberedOwnRunWait extends WakeProgress {
  readonly blockedAt: string;
  readonly undeliveredWake?: UndeliveredWake;
}

export interface OwnRunWake {
  readonly stillRunning: readonly WatchedProcess[];
}

export function ownRunWakeDecision(
  remembered: RememberedOwnRunWait | null,
  seenNow: { readonly blockedAt: string; readonly remindInMinutes: number; readonly processes: readonly WatchedProcess[] },
  now: number,
): { readonly wake?: OwnRunWake; readonly nextRemembered: RememberedOwnRunWait } {
  const previous = remembered?.blockedAt === seenNow.blockedAt ? remembered : null;
  const remindersSent = previous?.remindersSent ?? 0;
  const remindersDue = Math.max(0, Math.floor((now - Date.parse(seenNow.blockedAt)) / (seenNow.remindInMinutes * 60_000)));
  const wokenForNothingRunning = previous?.wokenForNothingRunning === true;
  const nothingRunningWakeIsDue = seenNow.processes.length === 0 && !wokenForNothingRunning;
  const nextRemembered = {
    blockedAt: seenNow.blockedAt,
    remindersSent: Math.max(remindersSent, remindersDue),
    wokenForNothingRunning: wokenForNothingRunning || nothingRunningWakeIsDue,
  };
  if (remindersDue <= remindersSent && !nothingRunningWakeIsDue) return { nextRemembered };
  return { wake: { stillRunning: seenNow.processes }, nextRemembered };
}

function runningFor(process: WatchedProcess, now: number): string {
  return process.startedAt === undefined
    ? shortenedCommand(process.command)
    : `${shortenedCommand(process.command)} (running ${formatDuration((now - process.startedAt) / 1000)})`;
}

export function buildOwnRunWakeMessage(wake: OwnRunWake, now: number): string {
  return [
    'You are waiting on your own background run.',
    wake.stillRunning.length > 0
      ? `Still running: ${wake.stillRunning.map((process) => runningFor(process, now)).join('; ')}.`
      : 'Nothing is still running.',
    'If your run has finished, read its result and continue. If you are still waiting, first check what is holding the run up, then run `throne my-state waiting-on-own-run "<what>"` and publish the marker again.',
    `When you declare again you may ask for a longer wait with \`--remind-in <minutes>\` (${SHORTEST_REMIND_IN_MINUTES} to ${LONGEST_REMIND_IN_MINUTES}); if you ask for none, the next reminder comes within ${DEFAULT_REMIND_IN_MINUTES} minutes.`,
    'If a run has gone on far longer than it should, it is stuck: find out what is holding it up and fix that cause; do not just start it again.',
  ].join('\n');
}

function ownRunWaitPath(agentName: string): string {
  return path.join(THRONE_DATA_DIR, agentName, 'own-run-wake.json');
}

export async function readRememberedOwnRunWait(agentName: string): Promise<RememberedOwnRunWait | null> {
  try {
    return JSON.parse(await readFile(ownRunWaitPath(agentName), 'utf8')) as RememberedOwnRunWait;
  } catch {
    return null;
  }
}

export async function writeRememberedOwnRunWait(agentName: string, remembered: RememberedOwnRunWait): Promise<void> {
  await mkdir(path.dirname(ownRunWaitPath(agentName)), { recursive: true });
  await writeFile(ownRunWaitPath(agentName), `${JSON.stringify(remembered)}\n`);
}

async function ownRunDeclaration(
  entry: AgentStatusesRosterEntry,
  deps: BlockedAgentPagingDependencies,
): Promise<{ readonly blockedAt: string; readonly remindInMinutes: number } | undefined> {
  const declared = await deps.readAgentState(entry.name);
  return declared.state === 'waiting-on-own-run'
    ? { blockedAt: declared.declaredAt, remindInMinutes: declared.remindInMinutes }
    : undefined;
}

const WAKE_STILL_BEING_DELIVERED = 'still being delivered';

async function rememberedWaitOnceDeliveryIsKnown(
  remembered: RememberedOwnRunWait | null,
  deps: BlockedAgentPagingDependencies,
): Promise<RememberedOwnRunWait | null | typeof WAKE_STILL_BEING_DELIVERED> {
  const wake = remembered?.undeliveredWake;
  if (remembered === null || wake === undefined) return remembered;
  const outcome = await deps.readMessageDeliveryOutcome(wake.key);
  const { blockedAt, remindersSent, wokenForNothingRunning } = remembered;
  const neverReachedThePane =
    outcome === undefined ||
    (outcome.state === MessageQueueWorkItemState.Failed &&
      [NOT_SENT_FAILURE_PREFIX, UNADDRESSABLE_RECIPIENT_FAILURE_PREFIX].some((prefix) =>
        (outcome.failureReason ?? '').startsWith(prefix),
      ));
  if (neverReachedThePane) {
    return { blockedAt, ...wake.progressBeforeTheWake };
  }
  if (outcome.state === MessageQueueWorkItemState.Delivered || outcome.state === MessageQueueWorkItemState.Failed) {
    return { blockedAt, remindersSent, wokenForNothingRunning };
  }
  return WAKE_STILL_BEING_DELIVERED;
}

export async function wakeAgentWaitingOnItsOwnRun(
  entry: AgentStatusesRosterEntry,
  paneId: string,
  deps: BlockedAgentPagingDependencies,
): Promise<void> {
  const agent = await deps.resolveAgent(entry.name);
  if (!agentStatusAcceptsInput(agent.agentStatus)) return;
  const declaration = await ownRunDeclaration(entry, deps);
  if (declaration === undefined) return;
  const { blockedAt } = declaration;
  const work = await deps.readHarnessBackgroundWork(paneId);
  if (work.kind === HARNESS_BACKGROUND_WORK_KINDS.UNKNOWN) return;
  const remembered = await rememberedWaitOnceDeliveryIsKnown(await deps.readRememberedOwnRunWait(entry.name), deps);
  if (remembered === WAKE_STILL_BEING_DELIVERED) return;
  const now = deps.now?.() ?? Date.now();
  const processes = work.kind === HARNESS_BACKGROUND_WORK_KINDS.RUNNING ? work.processes : [];
  const decision = ownRunWakeDecision(
    remembered,
    {
      ...declaration,
      processes: processes.map(({ pid, startedAt, command }) => ({ pid, startedAt, command })),
    },
    now,
  );
  if (decision.wake === undefined) {
    await deps.writeRememberedOwnRunWait(entry.name, decision.nextRemembered);
    return;
  }
  const key = `own-run-wake:${entry.name}:${blockedAt}:${now}`;
  await deps.writeRememberedOwnRunWait(entry.name, {
    ...decision.nextRemembered,
    undeliveredWake: {
      key,
      progressBeforeTheWake:
        remembered?.blockedAt === blockedAt
          ? { remindersSent: remembered.remindersSent, wokenForNothingRunning: remembered.wokenForNothingRunning }
          : {},
    },
  });
  await deps.submitToAgent(agent, NO_IDLING_SENDER, buildOwnRunWakeMessage(decision.wake, now), {
    key,
    composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
  });
}
