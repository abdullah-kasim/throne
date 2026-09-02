import {
  newAgentObjectiveContract,
  type ObjectiveContract,
} from "../shared-policy/objective-contract.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import type {
  CreateAgentDeps,
  RegistrationResolution,
  StageResult,
} from "./create.types.ts";
import { stderrWriter } from "./command-context.ts";

export async function resolveObjectiveContract(
  request: RegistrationResolution,
  deps: CreateAgentDeps,
): Promise<StageResult<ObjectiveContract | undefined>> {
  if (request.resuming) return { ok: true, value: request.objectiveContract };
  const normalizedRole = request.role.trim().toLowerCase();
  const needsSupervisorEvidence =
    normalizedRole === "shadow" &&
    request.flags["objective-code"] === undefined &&
    request.flags["non-campaign"] !== true;
  const result = newAgentObjectiveContract({
    role: request.role,
    name: request.name,
    supervisor: request.flags.supervisor as string,
    objectiveCode: request.flags["objective-code"],
    nonCampaign: request.flags["non-campaign"] === true,
    supervisorEvidence: needsSupervisorEvidence
      ? await deps.readSpawnSpec(request.flags.supervisor as string)
      : undefined,
  });
  if (result.ok) return { ok: true, value: result.contract };
  stderrWriter(deps)(
    `create-agent: refusing objective contract for "${request.name}" — ` +
      `${result.reason}. Nothing was registered or launched.\n`,
  );
  return { ok: false, code: 1 };
}

/**
 * Refuses a fresh campaign launch whose objective code has no matching
 * queue item, so `reap-agent` always has a queue item to mark complete
 * instead of the launch silently proceeding unlinked. Resumes and any
 * non-campaign or ad-hoc objective contract never reach this gate — their
 * identity and linkage are either already settled or out of scope for a
 * queue that only tracks campaigns.
 *
 * THERE IS NO BYPASS (the Lord's direct order, 2026-08-25): "create-agent
 * for alpha and shadow requires the objective code to exist in the queue
 * table", and then "remove bypass-objective-code". The flag previously let a
 * caller launch a campaign with no queue row, recording
 * `bypassedObjectiveCode: true` on the launch ledger. It worked exactly as
 * designed; the design is what was withdrawn.
 *
 * WHY, from the night it went: a live Alpha and its Shadow were running
 * against objective `hyd` with no queue row anywhere. `render-queue` could
 * not show it, so nobody could see the campaign existed — the Lord asked
 * what it was because he could not find it. It did not count toward the
 * ready queue the autoscaler reads, while its Alpha DID count toward the
 * live-Alpha floor, so it distorted both halves of one measurement. And
 * since only the Lord may authorise a queue row, a bypassed spawn routed
 * around that authority without anyone deciding to.
 *
 * The gate can now only refuse or admit, never grant an exception, so its
 * boolean result is always `false`. That is kept rather than deleted because
 * the launch ledger's historical entries still carry the field and must stay
 * readable.
 */
export async function resolveObjectiveCodeQueueGate(
  request: RegistrationResolution,
  objectiveContract: ObjectiveContract | undefined,
  deps: CreateAgentDeps,
): Promise<StageResult<boolean>> {
  if (request.resuming || objectiveContract?.kind !== "campaign") {
    return { ok: true, value: false };
  }
  const objectiveCode = objectiveContract.objectiveCode;
  const openStore = deps.openQueueStore ?? openRegentQueueStore;
  const store = openStore();
  let hasMatchingQueueItem: boolean;
  try {
    hasMatchingQueueItem =
      findQueueItemByObjectiveCode(store, objectiveCode) !== undefined;
  } finally {
    store.close();
  }
  if (hasMatchingQueueItem) return { ok: true, value: false };
  stderrWriter(deps)(
    `create-agent: refusing to launch "${request.name}" — no queue item ` +
      `recorded for objective code "${objectiveCode}". An Alpha or Shadow ` +
      `requires its objective code to exist in the queue table; there is no ` +
      `bypass. Ask the Lord to have the row filed — only a Stager files, and ` +
      `only on his word — then relaunch. Nothing was registered or launched.\n`,
  );
  return { ok: false, code: 1 };
}
