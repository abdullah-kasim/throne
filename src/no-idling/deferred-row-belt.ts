import {
  RegentQueueItemStatus,
  type DeferredRowPingQueue,
  type RegentQueueItemRow,
} from '../regent-queue/regent-queue.store.ts';
import type { QueueDeferral } from '../regent-queue/regent-queue-row.ts';
import type { NoIdlingDependencies } from './no-idling-dependencies.types.ts';
import { shouldMessageFamily } from './cooldown.ts';
import { NO_IDLING_REGENT_NAME } from './idle-family.ts';
import {
  NO_IDLING_SENDER,
  NO_IDLING_SUBMIT_TIMEOUT_MS,
  regentAcceptsNotice,
  writeErr,
  writeOut,
} from './no-idling-notify-guard.ts';

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
export const DEFERRED_ROW_PING_INTERVAL_MS = MILLISECONDS_PER_HOUR;
export const DEFERRED_ROW_HOLD_LIMIT_MS = 24 * MILLISECONDS_PER_HOUR;

export const DependencyState = {
  Done: 'done',
  Abandoned: 'abandoned',
  Missing: 'missing',
  Waiting: 'waiting',
} as const;

export type DependencyState = (typeof DependencyState)[keyof typeof DependencyState];

export const DeferredRowPingReason = {
  Ready: 'ready',
  DeadDependency: 'dead-dependency',
  HeldTooLong: 'held-too-long',
} as const;

export interface DeferredRowPing {
  readonly key: string;
  readonly text: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function readDependencyState(
  dependencyCode: string,
  rowsByObjectiveCode: ReadonlyMap<string, RegentQueueItemRow>,
): DependencyState {
  const row = rowsByObjectiveCode.get(dependencyCode);
  if (row === undefined) return DependencyState.Missing;
  if (row.status === RegentQueueItemStatus.Complete || row.deliveryMirror.verdict === 'delivered') {
    return DependencyState.Done;
  }
  if (row.status === RegentQueueItemStatus.Abandoned) return DependencyState.Abandoned;
  return DependencyState.Waiting;
}

function pingsForDeferredRow(
  objectiveCode: string,
  deferral: QueueDeferral,
  rowsByObjectiveCode: ReadonlyMap<string, RegentQueueItemRow>,
  nowMs: number,
): DeferredRowPing[] {
  const waitsOn = deferral.dependsOn.join(', ');
  const dependencyStates = deferral.dependsOn.map(
    (dependencyCode) => [dependencyCode, readDependencyState(dependencyCode, rowsByObjectiveCode)] as const,
  );
  const pings: DeferredRowPing[] = [];
  if (dependencyStates.every(([, state]) => state === DependencyState.Done)) {
    pings.push({
      key: `${objectiveCode}:${DeferredRowPingReason.Ready}`,
      text: `Deferred ${objectiveCode} can start: ${waitsOn} are done. Run release-deferred.`,
    });
  }
  for (const [dependencyCode, state] of dependencyStates) {
    if (state === DependencyState.Abandoned || state === DependencyState.Missing) {
      pings.push({
        key: `${objectiveCode}:${DeferredRowPingReason.DeadDependency}:${dependencyCode}`,
        text: `Deferred ${objectiveCode} waits on ${dependencyCode}, which is ${state}. Release or abandon it.`,
      });
    }
  }
  const heldForMs = deferral.deferredAt === null ? 0 : nowMs - deferral.deferredAt;
  if (heldForMs > DEFERRED_ROW_HOLD_LIMIT_MS) {
    pings.push({
      key: `${objectiveCode}:${DeferredRowPingReason.HeldTooLong}`,
      text: `Deferred ${objectiveCode} has been held for ${Math.floor(heldForMs / MILLISECONDS_PER_HOUR)} h waiting on ${waitsOn}.`,
    });
  }
  return pings;
}

export function planDeferredRowPings(
  items: readonly RegentQueueItemRow[],
  nowMs: number,
  lastPings: ReadonlyMap<string, number>,
): DeferredRowPing[] {
  const rowsByObjectiveCode = new Map(
    items.flatMap((row) => (row.objectiveCode === null ? [] : [[row.objectiveCode, row] as const])),
  );
  return items
    .flatMap((row) =>
      row.status === RegentQueueItemStatus.Deferred && row.deferral !== null
        ? pingsForDeferredRow(row.objectiveCode ?? row.id, row.deferral, rowsByObjectiveCode, nowMs)
        : [],
    )
    .filter((ping) =>
      shouldMessageFamily(ping.key, nowMs, lastPings.get(ping.key), DEFERRED_ROW_PING_INTERVAL_MS),
    );
}

function readQueueRows(queue: DeferredRowPingQueue): readonly RegentQueueItemRow[] {
  const read = queue.readAll();
  if (read.state === 'unknown') throw new Error(read.reason);
  return read.state === 'items' ? read.items : [];
}

async function tellRegentOfDeferredRowPings(
  deps: NoIdlingDependencies,
  queue: DeferredRowPingQueue,
  pings: readonly DeferredRowPing[],
  nowMs: number,
  notify: boolean,
): Promise<void> {
  if (pings.length === 0) return;
  const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
  if (!regentAcceptsNotice(regent.agentStatus)) {
    writeOut(deps, `no-idling: Regent is ${regent.agentStatus}; deferred-row pings wait for the next sweep\n`);
    return;
  }
  for (const ping of pings) {
    try {
      await deps.submitToAgent(regent, NO_IDLING_SENDER, ping.text, {
        key: `no-idling-deferred-row:${ping.key}:${nowMs}`,
        composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
      });
      if (notify) queue.recordDeferredRowPing(ping.key, nowMs);
      writeOut(deps, `no-idling: ${notify ? 'told' : '[dry-run] would tell'} Regent: ${ping.text}\n`);
    } catch (error) {
      writeErr(deps, `no-idling: deferred-row ping ${ping.key} failed: ${errText(error)}\n`);
    }
  }
}

export async function notifyRegentOfDeferredRows(
  deps: NoIdlingDependencies,
  notify: boolean,
): Promise<void> {
  const nowMs = (deps.now ?? Date.now)();
  let queue: DeferredRowPingQueue | undefined;
  try {
    queue = deps.openRegentQueue();
    const pings = planDeferredRowPings(readQueueRows(queue), nowMs, queue.readDeferredRowPings());
    await tellRegentOfDeferredRowPings(deps, queue, pings, nowMs, notify);
  } catch (error) {
    writeErr(deps, `no-idling: deferred-row check skipped: ${errText(error)}\n`);
  } finally {
    queue?.close();
  }
}
