import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { agentStatusAcceptsInput } from '../herdr/herdr-inventory.service.ts';
import { classifyLastMessageTags, lastMessageBlock } from '../no-idling/idle-pane-tag-classification.ts';
import { resolveBlockedTag } from '../no-idling/blocked-marker-resolution.ts';
import { NO_IDLING_SENDER, NO_IDLING_SUBMIT_TIMEOUT_MS } from '../no-idling/no-idling-notify-guard.ts';
import { formatDuration } from '../process-inspection/process-age.ts';
import {
  HARNESS_BACKGROUND_WORK_KINDS,
  shortenedCommand,
} from '../process-inspection/harness-background-work.ts';
import { MessageQueueWorkItemState } from '../message-queue/message-queue-work-item-state.ts';
import { NOT_SENT_FAILURE_PREFIX, UNADDRESSABLE_RECIPIENT_FAILURE_PREFIX } from '../throne-work/message-delivery-retry-policy.ts';
import { THRONE_DATA_DIR } from '../shared-policy/throne-home.ts';
import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';

export const OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS = 900_000;

export interface WatchedProcess {
  readonly pid: number;
  readonly startedAt?: number;
  readonly command: string;
}

export interface UndeliveredWake {
  readonly key: string;
  readonly ended: readonly WatchedProcess[];
  readonly previousLastWokenAt?: number;
}

export interface RememberedOwnRunWait {
  readonly blockedAt: string;
  readonly processes: readonly WatchedProcess[];
  readonly lastWokenAt?: number;
  readonly undeliveredWake?: UndeliveredWake;
}

export interface OwnRunWake {
  readonly ended: readonly WatchedProcess[];
  readonly stillRunning: readonly WatchedProcess[];
}

function sameProcess(left: WatchedProcess, right: WatchedProcess): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

export function ownRunWakeDecision(
  remembered: RememberedOwnRunWait | null,
  seenNow: { readonly blockedAt: string; readonly processes: readonly WatchedProcess[] },
  now: number,
): { readonly wake?: OwnRunWake; readonly nextRemembered: RememberedOwnRunWait } {
  const previous = remembered?.blockedAt === seenNow.blockedAt ? remembered : null;
  const ended = (previous?.processes ?? []).filter(
    (watched) => !seenNow.processes.some((seen) => sameProcess(seen, watched)),
  );
  const lastWokenAt = previous?.lastWokenAt;
  const markerAge = now - Date.parse(seenNow.blockedAt);
  const timedWakeIsDue =
    markerAge >= OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS &&
    (lastWokenAt === undefined || now - lastWokenAt >= OWN_BACKGROUND_RUN_WAKE_INTERVAL_MS);
  if (ended.length === 0 && !timedWakeIsDue) {
    return { nextRemembered: { blockedAt: seenNow.blockedAt, processes: seenNow.processes, lastWokenAt } };
  }
  return {
    wake: { ended, stillRunning: seenNow.processes },
    nextRemembered: { blockedAt: seenNow.blockedAt, processes: seenNow.processes, lastWokenAt: now },
  };
}

function runningFor(process: WatchedProcess, now: number): string {
  return process.startedAt === undefined
    ? shortenedCommand(process.command)
    : `${shortenedCommand(process.command)} (running ${formatDuration((now - process.startedAt) / 1000)})`;
}

export function buildOwnRunWakeMessage(wake: OwnRunWake, now: number): string {
  return [
    'You are waiting on your own background run.',
    ...(wake.ended.length > 0
      ? [
          `Ended: ${wake.ended.map((process) => shortenedCommand(process.command)).join('; ')}.`,
          'If the run you were waiting for is listed as ended, your wait is over: read its result, continue, and end your reply without the marker line, even if something is still running, and ignore the later instruction to publish the marker again. Stop or ignore anything still running that you are not waiting on.',
        ]
      : []),
    wake.stillRunning.length > 0
      ? `Still running: ${wake.stillRunning.map((process) => runningFor(process, now)).join('; ')}.`
      : 'Nothing is still running.',
    'If your run has finished, read its result and continue. If you are still waiting, first check what is holding the run up, then publish the marker again. If a run has gone on far longer than it should, it is stuck: find out what is holding it up and fix that cause; do not just start it again.',
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

async function ownRunMarkerBlockedAt(
  entry: AgentStatusesRosterEntry,
  deps: BlockedAgentPagingDependencies,
): Promise<string | undefined> {
  const tag = await resolveBlockedTag(
    entry.name,
    async () => classifyLastMessageTags(lastMessageBlock(await deps.readAgent(entry.name))),
    deps.blockedMarkerLedger,
  );
  if (tag.kind !== 'blocked' || tag.waitsOnOwnBackgroundRun !== true || tag.blockedBy.length > 0) return undefined;
  return (await deps.blockedMarkerLedger.readBlockedMarker(entry.name))?.blockedAt;
}

const WAKE_STILL_BEING_DELIVERED = 'still being delivered';

async function rememberedWaitOnceDeliveryIsKnown(
  remembered: RememberedOwnRunWait | null,
  deps: BlockedAgentPagingDependencies,
): Promise<RememberedOwnRunWait | null | typeof WAKE_STILL_BEING_DELIVERED> {
  const wake = remembered?.undeliveredWake;
  if (remembered === null || wake === undefined) return remembered;
  const outcome = await deps.readMessageDeliveryOutcome(wake.key);
  const { blockedAt, processes, lastWokenAt } = remembered;
  const neverReachedThePane =
    outcome === undefined ||
    (outcome.state === MessageQueueWorkItemState.Failed &&
      [NOT_SENT_FAILURE_PREFIX, UNADDRESSABLE_RECIPIENT_FAILURE_PREFIX].some((prefix) =>
        (outcome.failureReason ?? '').startsWith(prefix),
      ));
  if (neverReachedThePane) {
    return { blockedAt, processes: [...processes, ...wake.ended], lastWokenAt: wake.previousLastWokenAt };
  }
  if (outcome.state === MessageQueueWorkItemState.Delivered || outcome.state === MessageQueueWorkItemState.Failed) {
    return { blockedAt, processes, lastWokenAt };
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
  const blockedAt = await ownRunMarkerBlockedAt(entry, deps);
  if (blockedAt === undefined) return;
  const work = await deps.readHarnessBackgroundWork(paneId);
  if (work.kind === HARNESS_BACKGROUND_WORK_KINDS.UNKNOWN) return;
  const remembered = await rememberedWaitOnceDeliveryIsKnown(await deps.readRememberedOwnRunWait(entry.name), deps);
  if (remembered === WAKE_STILL_BEING_DELIVERED) return;
  const now = deps.now?.() ?? Date.now();
  const processes = work.kind === HARNESS_BACKGROUND_WORK_KINDS.RUNNING ? work.processes : [];
  const decision = ownRunWakeDecision(
    remembered,
    {
      blockedAt,
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
      ended: decision.wake.ended,
      previousLastWokenAt: remembered?.blockedAt === blockedAt ? remembered.lastWokenAt : undefined,
    },
  });
  await deps.submitToAgent(agent, NO_IDLING_SENDER, buildOwnRunWakeMessage(decision.wake, now), {
    key,
    composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
  });
}
