// Requirement: a message addressed to an agent that has gone away must fail
// that one message, not the delivery server.
//
// Measured 2026-08-29. `pollAndYieldOrDeliver` awaits `resolveAgent`, which
// throws `AgentResolutionError` the moment a recipient has gone COMPLETE/DEAD —
// an ordinary event, because agents are reaped constantly while their in-flight
// mail is still queued. `SqliteQueueDrainHostedWorker` `void`ed that promise
// with a `.finally()` and no `.catch()`, so the rejection was unhandled and
// Node exited ~8 s after every boot: first on `alpha-kir510b-fable`, then on
// `shadow-kir510b-08`.
//
// The outage was invisible from every status surface. `nest --watch` supervises
// the application but does not restart it on a clean exit, and systemd watches
// the SUPERVISOR — so `systemctl` reported `active running` for 70 minutes with
// no application behind it, until the watchdog starved and ABRTed. Five kills
// in one night, 70 minutes apart, message delivery dead throughout.
//
// SCOPE OF THIS FILE, stated because a reader will otherwise assume more: it
// pins the REJECTING SEAM — that an unresolvable recipient makes this function
// reject, which is the hazard the drain must contain. The drain's own `.catch`
// is not reachable from a constructor-injected stub: the worker wires
// `probeComposerCleared` only when `handlerDeps.messageDelivery` is undefined,
// and that path resolves the REAL herdr agent, so a test that stubs delivery
// silently skips the throwing branch altogether. An earlier version of this
// file did exactly that and passed with the guard deleted. The guard itself was
// verified against the live service instead.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pollAndYieldOrDeliver } from "../message-queue/sqlite-delivery-sandbox.ts";
import { MESSAGE_DELIVERY_WORK_ITEM_KIND } from "../send-agent/message-delivery-enqueue.ts";
import type { WorkItemRow } from "../message-queue/message-queue.store.ts";

/** The exact error shape `resolveAgent` raises for a departed recipient. */
class AgentResolutionError extends Error {
  constructor(requestedName: string) {
    super(
      `no herdr agent named "${requestedName}" — it may have gone COMPLETE/DEAD`,
    );
  }
}

function queuedMessageTo(recipientName: string): WorkItemRow {
  return {
    id: 1,
    kind: MESSAGE_DELIVERY_WORK_ITEM_KIND,
    state: "in-flight",
    payload: { recipientName, prompt: "any body", senderName: "tester" },
  } as unknown as WorkItemRow;
}

function depsRefusing(recipientName: string): Parameters<typeof pollAndYieldOrDeliver>[1] {
  return {
    laneBoundMs: 60_000,
    resolveAgent: () => {
      throw new AgentResolutionError(recipientName);
    },
    // Defined on purpose: this is the branch the live server takes, and it is
    // the ONLY branch that calls resolveAgent.
    probeComposerCleared: async () => true,
    reschedule: async () => {},
    deliver: async () => {
      throw new Error("deliver must not be reached once resolution has failed");
    },
  } as unknown as Parameters<typeof pollAndYieldOrDeliver>[1];
}

test("a departed recipient makes the delivery attempt reject rather than resolve", async () => {
  await assert.rejects(
    () =>
      pollAndYieldOrDeliver(
        queuedMessageTo("shadow-kir510b-08"),
        depsRefusing("shadow-kir510b-08"),
        1_000,
        1_000,
      ),
    /no herdr agent named "shadow-kir510b-08"/,
    "an unresolvable recipient must surface as a rejection the caller has to contain",
  );
});

test("the rejection names the recipient, so a crash can be traced to one message", async () => {
  // The outage was diagnosable only because the recipient name reached the log.
  // Losing it would leave a bare stack and no way to find the poison message.
  await assert.rejects(
    () =>
      pollAndYieldOrDeliver(
        queuedMessageTo("alpha-kir510b-fable"),
        depsRefusing("alpha-kir510b-fable"),
        1_000,
        1_000,
      ),
    (error: unknown) =>
      error instanceof Error && error.message.includes("alpha-kir510b-fable"),
  );
});
