import { Injectable, Optional } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import {
  deriveLaneBoundMs,
  deriveMinimumDeliveryAttemptFloorMs,
  deriveSandboxHardKillBoundMs,
  measureWritePhaseWorstCaseMs,
} from "../message-queue/sqlite-delivery-bounds.ts";
import {
  armHardKillTimer,
  pollAndYieldOrDeliver,
} from "../message-queue/sqlite-delivery-sandbox.ts";
import { openMessageQueueStore, type MessageQueueStore } from "../message-queue/message-queue.store.ts";
import { MESSAGE_DELIVERY_WORK_ITEM_KIND } from "../send-agent/message-delivery-enqueue.ts";
import { probeComposerCleared, REAL_SUBMIT_TO_AGENT_DEPS } from "../herdr/herdr-send.service.ts";
import {
  deliverMessageWorkItem,
  REAL_MESSAGE_DELIVERY_HANDLER_DEPS,
  type MessageDeliveryHandlerDeps,
} from "../throne-work/message-delivery-handler.ts";
import {
  listNonMessageDispatchWorkKinds,
  reclaimOrphanedInFlightWorkItemsAsAssumedFilled,
  runDispatchTick,
  type ThroneWorkHandlerDeps,
} from "../throne-work/dispatch-loop.ts";
import type { CronHostedWorker } from "./hosted-worker.types.ts";

export const SQLITE_QUEUE_DRAIN_HOSTED_WORKER_NAME = "sqlite-queue-drain";
const SQLITE_DELIVERY_POLL_INTERVAL_MS = 1_000;

@Injectable()
export class SqliteQueueDrainHostedWorker implements CronHostedWorker {
  readonly kind = "cron" as const;
  readonly workerName = SQLITE_QUEUE_DRAIN_HOSTED_WORKER_NAME;
  readonly cronExpression = CronExpression.EVERY_SECOND;

  private readonly dispatchingItemIds = new Set<number>();
  private reclaimedOrphanedWork = false;

  constructor(
    @Optional() private readonly store: MessageQueueStore = openMessageQueueStore(),
    @Optional() private readonly handlerDeps: ThroneWorkHandlerDeps = {},
    /** Test seam for the composer-cleared probe; production derives it below. */
    @Optional() private readonly composerProbe?: typeof probeComposerCleared,
  ) {}

  async runOnce(): Promise<void> {
    if (!this.reclaimedOrphanedWork) {
      reclaimOrphanedInFlightWorkItemsAsAssumedFilled(this.store);
      this.reclaimedOrphanedWork = true;
    }
    // The liveness heartbeat is THIS tick's proof of life, so it is written
    // before anything is claimed. It used to be written only by
    // `runDispatchTick`, i.e. only on ticks with no message delivery due —
    // and a delivery that keeps yielding on a resident draft is due again
    // every second, so a court with one occupied composer reported a stale
    // heartbeat ("DEGRADED COURT") from every enqueue for as long as the
    // draft sat there (measured on the mac, 2026-09-02: 7+ minutes and
    // counting, with the drain perfectly healthy).
    this.store.writeHeartbeat();
    const item = this.store.claimNextDueWorkItem([MESSAGE_DELIVERY_WORK_ITEM_KIND]);
    if (item === undefined) {
      runDispatchTick(this.store, this.dispatchingItemIds, this.handlerDeps);
      return;
    }
    // The same yielding delivery starved every other work kind for the same
    // reason: a message claim returned early and the non-message tick never
    // ran, so a Regent resurrection enqueued behind an occupied composer
    // waited until that composer cleared. Dispatch the other kinds on every
    // tick regardless; message delivery stays with the sandbox below.
    runDispatchTick(
      this.store,
      this.dispatchingItemIds,
      this.handlerDeps,
      listNonMessageDispatchWorkKinds(),
    );
    this.dispatchingItemIds.add(item.id);
    const deliveryDeps = this.handlerDeps.messageDelivery ?? REAL_MESSAGE_DELIVERY_HANDLER_DEPS;
    const laneBoundMs = deriveLaneBoundMs();
    const timer = armHardKillTimer(
      deriveSandboxHardKillBoundMs(
        laneBoundMs,
        measureWritePhaseWorstCaseMs(),
      ),
    );
    void pollAndYieldOrDeliver(
      item,
      {
        laneBoundMs,
        resolveAgent: deliveryDeps.resolveAgent,
        probeComposerCleared:
          this.composerProbe !== undefined
            ? (agent, options) =>
                this.composerProbe!(agent, options, REAL_SUBMIT_TO_AGENT_DEPS)
            : this.handlerDeps.messageDelivery === undefined
              ? (agent, options) =>
                  probeComposerCleared(agent, options, REAL_SUBMIT_TO_AGENT_DEPS)
              : undefined,
        reschedule: async (id, delayMs) => {
          const accumulatedWaitMs =
            ((item.payload as { accumulatedWaitMs?: number }).accumulatedWaitMs ?? 0) + delayMs;
          this.store.rescheduleClaimedWorkItem(id, delayMs, accumulatedWaitMs);
        },
        deliver: (claimed, _deliveryWaitMs) =>
          deliverMessageWorkItem(this.store, claimed, deliveryDeps as MessageDeliveryHandlerDeps),
      },
      SQLITE_DELIVERY_POLL_INTERVAL_MS,
      deriveMinimumDeliveryAttemptFloorMs(),
    )
      // WITHOUT THIS CATCH, ONE UNDELIVERABLE MESSAGE KILLS THE WHOLE SERVER.
      // `pollAndYieldOrDeliver` awaits `resolveAgent`, which throws
      // `AgentResolutionError` the moment a recipient has gone COMPLETE/DEAD —
      // an ordinary event, not an exceptional one, because agents are reaped
      // constantly while their in-flight mail is still queued. The call is
      // `void`ed with a floating promise, so that rejection was unhandled and
      // Node exited.
      //
      // Measured 2026-08-29: the process died ~8 s after every boot on
      // `alpha-kir510b-fable`, then on `shadow-kir510b-08`. `nest --watch`
      // supervises the app but does not restart it on a clean exit, and
      // systemd watches the SUPERVISOR — so the unit reported `active
      // running` for 70 minutes with no application behind it, until the
      // watchdog starved and ABRTed. Five kills in one night, 70 minutes
      // apart, message delivery dead the whole time while every status
      // surface said healthy.
      //
      // An unresolvable recipient fails THAT WORK ITEM and nothing else.
      // `failDeliveryAttempt` records the reason and applies backoff, so a
      // genuinely transient resolution failure still retries while a
      // permanently departed agent stops taking the server down with it.
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        try {
          this.store.failDeliveryAttempt(
            item.id,
            `delivery attempt threw: ${reason}`,
            SQLITE_DELIVERY_POLL_INTERVAL_MS,
          );
        } catch (failureError: unknown) {
          // Never let the failure bookkeeping become the new crash.
          console.error(
            `[sqlite-queue-drain] could not record failure for work item ${item.id}:`,
            failureError,
          );
        }
        console.error(
          `[sqlite-queue-drain] work item ${item.id} failed and was NOT delivered:`,
          reason,
        );
      })
      .finally(() => {
        timer.clear();
        this.dispatchingItemIds.delete(item.id);
      });
  }
}
