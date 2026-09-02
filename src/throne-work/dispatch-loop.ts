import { MESSAGE_DELIVERY_WORK_ITEM_KIND } from "../send-agent/message-delivery-enqueue.ts";
import {
  MessageQueueWorkItemState,
  type MessageQueueStore,
  type WorkItemRow,
} from "../message-queue/message-queue.store.ts";
import {
  deliverMessageWorkItem,
  type MessageDeliveryHandlerDeps,
} from "./message-delivery-handler.ts";
import {
  REAL_REGENT_RESURRECTION_HANDLER_DEPS,
  REGENT_RESURRECTION_WORK_ITEM_KIND,
  resurrectRegentWorkItem,
  type RegentResurrectionHandlerDeps,
} from "./regent-resurrection.ts";

/**
 * The typed reason recorded on an `in-flight` work item this process finds
 * already claimed at startup — left behind by a prior process that crashed
 * (or was killed) between claiming the item and confirming its outcome.
 * Nothing survives a hard kill to say whether the pane write already
 * happened, so resuming it as an ordinary retry could duplicate a delivery
 * that already landed — the one outcome the campaign's retry-safety
 * boundary forbids outright. Terminal-failing it instead keeps the
 * invariant "retry only where provably safe" intact and leaves an honest,
 * typed, pollable trail (`message-status` reports `failed-with-reason`)
 * instead of either a silent duplicate or a row stranded in `in-flight`
 * forever.
 */
export const ORPHANED_IN_FLIGHT_AFTER_RESTART_REASON =
  "orphaned in-flight work item found at server startup: the prior process " +
  "crashed with an unreadable outcome (the pane write may or may not have " +
  "completed), so it is assumed filled and was not resent — verify with the " +
  "recipient and resend manually if it was not delivered";

/**
 * The dispatch loop's combined deps bag: one field per registered work
 * kind's own handler deps, each defaulted independently so a caller that
 * only cares about one kind (e.g. a message-delivery-only test) never has
 * to know the other kind's shape.
 */
export interface ThroneWorkHandlerDeps {
  messageDelivery?: MessageDeliveryHandlerDeps;
  regentResurrection?: RegentResurrectionHandlerDeps;
}

/**
 * Registered work kinds, by handler — `message-delivery` (the original
 * campaign) and `regent-resurrection` (routed through the same durable
 * queue by ruling; see `regent-resurrection.ts`). The table's existence,
 * not a fixed count of implemented kinds, is the seam that makes a future
 * work type additive.
 */
const WORK_KIND_HANDLERS: ReadonlyMap<
  string,
  (store: MessageQueueStore, item: WorkItemRow, deps: ThroneWorkHandlerDeps) => Promise<WorkItemRow>
> = new Map([
  [
    MESSAGE_DELIVERY_WORK_ITEM_KIND,
    (store, item, deps) => deliverMessageWorkItem(store, item, deps.messageDelivery),
  ],
  [
    REGENT_RESURRECTION_WORK_ITEM_KIND,
    (store, item, deps) => resurrectRegentWorkItem(store, item, deps.regentResurrection),
  ],
]);


/**
 * The typed reason recorded when a handler itself throws rather than
 * resolving to a terminal state through its own retry-safety boundary — a
 * bug in the handler, not a classified submit outcome.
 */
export const HANDLER_THREW_REASON_PREFIX = "handler threw, not resent: ";

/**
 * The dispatch loop's own containment boundary: a handler promise is
 * dispatched with `void`, so without a `.catch()` here a thrown/rejected
 * handler becomes an unhandled rejection and Node kills the whole
 * throne-work process — exactly the fault CRS fixed one call site of and
 * this campaign's own `recordDeliveryFailureNoticeSafely` fixed a second
 * instance of. This is the same containment one layer up: a handler that
 * throws must never take the tick, or the process, down with it, and the
 * item it was working on must not be left silently stuck `in-flight`
 * forever. `finishWorkItemIdempotently` is used (not the strict
 * `transitionWorkItemState`) because the handler may have already reached
 * its own terminal state before throwing on some later, unrelated step (see
 * `recordAttributedDelivery`'s own non-fatal failure mode) — that race is
 * exactly what CRS's idempotent-finish guard exists to tolerate. If even
 * that terminal-fail attempt throws, it is logged and swallowed too: this
 * function's contract is "never propagate," full stop.
 */
function containHandlerThrow(store: MessageQueueStore, item: WorkItemRow, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `throne-work: work item ${item.id} (kind ${item.kind}) handler threw, containing: ${message}\n`,
  );
  try {
    store.finishWorkItemIdempotently(item.id, MessageQueueWorkItemState.Failed, {
      failureReason: `${HANDLER_THREW_REASON_PREFIX}${message}`,
    });
  } catch (terminalFailError) {
    process.stderr.write(
      `throne-work: work item ${item.id} could not even be terminal-failed after its handler threw, ` +
        `leaving it as-is rather than crashing: ${
          terminalFailError instanceof Error ? terminalFailError.message : String(terminalFailError)
        }\n`,
    );
  }
}

/**
 * A crashed process's orphaned in-flight item has exactly two possible true
 * states — the pane write landed (`filled`) or it didn't (`empty`) — and no
 * third "indeterminate" verdict, because that would just be encoding our own
 * inability to observe the prior process's last moment as if it were a fact
 * about the pane. With no way to look again (the process that could have
 * looked is gone), this terminal-fails the item under the structural
 * assume-filled default and leaves an honest, typed, pollable trail instead
 * of silently resending into a possibly-already-delivered pane.
 *
 * Terminal-fails every `in-flight` work item found at process startup under
 * that default (see `ORPHANED_IN_FLIGHT_AFTER_RESTART_REASON`). Called
 * exactly once, before the poll loop's first tick, so it only ever sees
 * items a *prior* process claimed — this process's own claims are tracked
 * in-memory (`dispatchingItemIds`) and are never touched here.
 */
export function reclaimOrphanedInFlightWorkItemsAsAssumedFilled(store: MessageQueueStore): WorkItemRow[] {
  return store.listWorkItemsByStates([MessageQueueWorkItemState.InFlight]).map((item) =>
    store.transitionWorkItemState(item.id, MessageQueueWorkItemState.Failed, {
      failureReason: ORPHANED_IN_FLIGHT_AFTER_RESTART_REASON,
    }),
  );
}

/**
 * One poll cycle: write the liveness heartbeat, then atomically claim and
 * dispatch one due work item. The claim commits before the handler starts, so
 * a pane wait cannot retain SQLite's write transaction or block a later tick.
 */
/**
 * Every registered work kind EXCEPT pane message delivery — the kinds a
 * drain tick may dispatch through the plain handler table while a message
 * delivery is being handled by the composer-polling sandbox instead.
 */
export function listNonMessageDispatchWorkKinds(): string[] {
  return [...WORK_KIND_HANDLERS.keys()].filter((kind) => kind !== MESSAGE_DELIVERY_WORK_ITEM_KIND);
}

export function runDispatchTick(
  store: MessageQueueStore,
  dispatchingItemIds: Set<number>,
  deps: ThroneWorkHandlerDeps = {},
  kinds: readonly string[] = [...WORK_KIND_HANDLERS.keys()],
): WorkItemRow[] {
  store.writeHeartbeat();
  store.sweepExpiredTerminalWorkItems();
  const item = store.claimNextDueWorkItem(kinds);
  if (item === undefined) return [];

  dispatchingItemIds.add(item.id);
  const handler = WORK_KIND_HANDLERS.get(item.kind)!;
  void handler(store, item, deps)
    .catch((error) => containHandlerThrow(store, item, error))
    .finally(() => dispatchingItemIds.delete(item.id));

  return [item];
}

export interface ThroneWorkDispatchLoopOptions {
  pollIntervalMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  shouldStop: () => boolean;
  handlerDeps?: ThroneWorkHandlerDeps;
  /**
   * Called once per cycle, after dispatch and before the sleep. Exists so
   * the standalone `throne-work` command can refresh its service-generation
   * marker on a timer without this file knowing anything about markers.
   * Wrapped in its own try/catch here (on top of whatever the callback does
   * internally) because this loop's own containment rule is absolute: no
   * per-tick callback may take the dispatch loop -- and with it, live
   * message delivery -- down with it.
   */
  onTick?: () => void;
}

/**
 * The server's main loop: poll, heartbeat, dispatch, sleep, repeat, until
 * `shouldStop()` says otherwise. Runs until the process is killed in
 * production; `shouldStop` exists so tests can run a bounded number of
 * cycles against a real clock instead of an infinite loop.
 */
export async function runThroneWorkDispatchLoop(
  store: MessageQueueStore,
  options: ThroneWorkDispatchLoopOptions,
): Promise<void> {
  reclaimOrphanedInFlightWorkItemsAsAssumedFilled(store);
  const dispatchingItemIds = new Set<number>();
  while (!options.shouldStop()) {
    runDispatchTick(store, dispatchingItemIds, options.handlerDeps);
    try {
      options.onTick?.();
    } catch (error) {
      process.stderr.write(
        `throne-work: onTick callback threw, continuing: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    await options.sleep(options.pollIntervalMs);
  }
}
