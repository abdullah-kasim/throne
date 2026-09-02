// Regent resurrection, routed through the SAME durable queue as every other
// throne message — no code-level bypass. The Lord's ruling (2026-08-11):
// keep-going, no-idling, and throne-work's own dispatch server are all
// throne code; a "resurrect directly if the queue looks down" branch would
// be throne code defending against throne code being broken, which buys
// nothing real and costs a second path to maintain and test forever. The
// actual safety layer for a dead/crash-looping `throne-work.service` is
// systemd's own `Restart=always` (see AGENTS.md / the unit file), one layer
// BELOW the throne — exactly where recovery for the throne belongs.
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
  type WorkItemRow,
} from "../message-queue/message-queue.store.ts";
import { resurrectRegent as resurrectRegentReal } from "../regent-state/regent-state.service.ts";
import {
  REAL_ENQUEUE_HEARTBEAT_MESSAGE_DEPS,
  warnIfDegradedAndCheckSustainedOutage,
  type EnqueueHeartbeatMessageDeps,
} from "./enqueue-heartbeat-message.ts";

/** The one work kind this module registers on the durable queue. */
export const REGENT_RESURRECTION_WORK_ITEM_KIND = "regent-resurrection";

/**
 * A fixed dedupe key — there is only ever one Regent to resurrect, so a
 * second resurrection request while the first is still `queued` supersedes
 * it rather than risking two resurrections racing once the server catches
 * up. `resurrectRegent` itself also re-checks `findLiveRegent()` immediately
 * before it spawns (see its own doc comment) and skips the spawn on a
 * confirmed-live match, so this is a belt-and-braces queue-level dedupe, not
 * the only guard.
 */
export const REGENT_RESURRECTION_DEDUPE_KEY = "regent-resurrection";

/**
 * Enqueues a resurrection request instead of resurrecting inline — the
 * client-side half. Runs the same degraded-court warning + sustained-outage
 * escalation every enqueue into this queue runs (see
 * `warnIfDegradedAndCheckSustainedOutage`), so a resurrection request queued
 * into a dead server is never silently green either.
 */
export async function enqueueRegentResurrection(
  deps: EnqueueHeartbeatMessageDeps = REAL_ENQUEUE_HEARTBEAT_MESSAGE_DEPS,
  openStore: () => MessageQueueStore = openMessageQueueStore,
): Promise<WorkItemRow> {
  const store = openStore();
  try {
    await warnIfDegradedAndCheckSustainedOutage(store, deps);
    return store.insertWorkItem({
      kind: REGENT_RESURRECTION_WORK_ITEM_KIND,
      payload: {},
      dedupeKey: REGENT_RESURRECTION_DEDUPE_KEY,
    });
  } finally {
    store.close();
  }
}

export interface RegentResurrectionHandlerDeps {
  resurrectRegent: () => Promise<unknown>;
}

export const REAL_REGENT_RESURRECTION_HANDLER_DEPS: RegentResurrectionHandlerDeps = {
  resurrectRegent: resurrectRegentReal,
};

/**
 * The server-side half: drains one `regent-resurrection` work item by
 * actually resurrecting. `resurrectRegent` runs in the throne-work server
 * process — the same process systemd restarts on a crash — never in the
 * short-lived `keep-going` CLI invocation that enqueued the request.
 */
export async function resurrectRegentWorkItem(
  store: MessageQueueStore,
  item: WorkItemRow,
  deps: RegentResurrectionHandlerDeps = REAL_REGENT_RESURRECTION_HANDLER_DEPS,
): Promise<WorkItemRow> {
  try {
    await deps.resurrectRegent();
    return store.finishWorkItemIdempotently(item.id, MessageQueueWorkItemState.Delivered);
  } catch (error) {
    return store.finishWorkItemIdempotently(item.id, MessageQueueWorkItemState.Failed, {
      failureReason: error instanceof Error ? error.message : String(error),
    });
  }
}
