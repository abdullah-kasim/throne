import {
  RegentQueueItemStatus,
  type RegentQueueItemStatus as QueueStatus,
} from "../regent-queue/regent-queue-item-state.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import {
  openRegentQueueStore,
  type QueueDeliveryMirror,
  type QueueItemMutation,
  type RegentQueueItemRow,
  type RegentQueueMutationStore,
} from "../regent-queue/regent-queue.store.ts";
import { queueAddressingObjectiveCode } from "../shared-policy/objective-contract.ts";
import { parseQueuePriority } from "../regent-queue/regent-queue-row.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { herdrAgentNameRefusal } from "../herdr/herdr-identity.service.ts";

const ABSORBED_BY_OBJECTIVE_FLAG = "--absorbed-by-objective";
const PRIORITY_FLAG = "--priority";
const DEPENDS_ON_FLAG = "--depends-on";
const RELEASE_AUTHORITY_FLAG = "--release-authority";
const DEFER_REASON_FLAG = "--defer-reason";

/**
 * Body edits are their own parsed shape rather than a plain string field,
 * because the destructive one is not the only one anybody wants.
 *
 * `--body` replaced the stored body silently, and on 2026-08-25 that ate a
 * Regent's HELD banner off four rows: the Stager amended each body to add a
 * ruling and had no non-destructive verb available, so it passed the whole new
 * text and the explanation of why those rows were being held vanished. The
 * hold itself survived; the reason a future Regent would have needed did not.
 *
 * Three corrections, in order of how much they help:
 *  1. `--prepend-body` / `--append-body` exist, so amending no longer requires
 *     replacing. This removes the reason the mistake happened.
 *  2. The destructive verb is spelled `--replace-body`. `--body` still works —
 *     it is in muscle memory and in scripts — but it warns and names its
 *     replacement, because a flag whose name does not contain its verb makes
 *     the caller supply the verb from memory.
 *  3. A replace REPORTS what it dropped, naming any load-bearing line the old
 *     body carried and the new one does not. This is the one that would have
 *     caught the original mistake even under the old flag name.
 */
export type QueueBodyEditMode = "replace" | "prepend" | "append";

export interface QueueBodyEdit {
  readonly mode: QueueBodyEditMode;
  readonly text: string;
}

const BODY_FLAGS = new Map<string, QueueBodyEditMode>([
  ["--replace-body", "replace"],
  ["--body", "replace"],
  ["--prepend-body", "prepend"],
  ["--append-body", "append"],
]);

/** Lines whose disappearance from a body is worth saying out loud: an
 *  operational hold, and the Stager plan markers `lint-queue-plan` requires.
 *  Matched case-sensitively on the uppercase forms those conventions use. */
const LOAD_BEARING_BODY_MARKERS: readonly string[] = [
  "HELD",
  "BLOCKED",
  "DO NOT LAUNCH",
  "INTENT:",
  "SCOPE:",
  "RULINGS:",
  "VERIFIED-NOUNS:",
];

/** What a replace is about to destroy, as a human sentence, or `undefined`
 *  when it destroys nothing worth mentioning. Pure: no store, no I/O. */
export function describeReplacedBody(
  oldBody: string,
  newBody: string,
): string | undefined {
  if (oldBody === newBody) return undefined;
  const dropped = LOAD_BEARING_BODY_MARKERS.filter(
    (marker) => oldBody.includes(marker) && !newBody.includes(marker),
  );
  const size = `replaced the stored body (${oldBody.length} chars) with ${newBody.length} chars`;
  if (dropped.length === 0) {
    return `${size}. The previous text is gone; use --prepend-body or --append-body to amend without replacing.`;
  }
  return (
    `${size}, and DROPPED ${dropped.length} load-bearing marker(s) the old ` +
    `body carried: ${dropped.join(", ")}. If that was not deliberate, restore ` +
    `them now — and use --prepend-body or --append-body to amend without replacing.`
  );
}

const STRING_FIELDS = new Map<string, keyof QueueItemMutation>([
  ["--agent-name", "agentName"],
  ["--target-repo", "targetRepo"],
  ["--base-commit", "baseCommit"],
  ["--delivery-commit", "deliveryCommit"],
  ["--pr-branch", "prBranch"],
]);
const CLEAR_FIELDS = new Map<string, keyof QueueItemMutation>([
  ["--clear-agent-name", "agentName"],
  ["--clear-target-repo", "targetRepo"],
  ["--clear-base-commit", "baseCommit"],
  ["--clear-delivery-commit", "deliveryCommit"],
  ["--clear-pr-branch", "prBranch"],
]);
const CLEAR_FLAG_BY_FIELD = new Map<keyof QueueItemMutation, string>(
  Array.from(CLEAR_FIELDS, ([clearFlag, field]) => [field, clearFlag]),
);

function refuseEmptyStringFieldValue(
  flag: string,
  field: keyof QueueItemMutation,
  value: string,
): void {
  if (value.trim() !== "") return;
  const clearFlag = CLEAR_FLAG_BY_FIELD.get(field);
  const nullingAdvice =
    clearFlag === undefined
      ? "no --clear-* counterpart exists for this flag"
      : `use ${clearFlag} to intentionally clear it`;
  throw new Error(
    `update-queue: ${flag} refuses an empty or whitespace-only value (${nullingAdvice})`,
  );
}

export interface UpdateQueueInput {
  readonly objectiveCode: string;
  readonly mutation: QueueItemMutation;
  /** Resolved against the stored body inside `updateQueueItem`, which is the
   *  only place that can see it. */
  readonly bodyEdit?: QueueBodyEdit;
  /** True when the caller reached a body edit through the verb-less `--body`
   *  spelling, so `run` can point at `--replace-body`. */
  readonly usedLegacyBodyFlag?: boolean;
}

export function parseUpdateQueueArgs(args: string[]): UpdateQueueInput {
  let objectiveCode: string | undefined;
  let bodyEdit: QueueBodyEdit | undefined;
  let dependsOn: string[] | undefined;
  let releaseAuthority: string | undefined;
  let deferReason: string | undefined;
  let usedLegacyBodyFlag = false;
  const mutation: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--objective-code") {
      objectiveCode = queueAddressingObjectiveCode(args[++index] ?? "");
      continue;
    }
    if (flag === "--status") {
      const status = args[++index];
      if (!Object.values(RegentQueueItemStatus).includes(status as QueueStatus))
        throw new Error(`update-queue: invalid status "${status ?? ""}"`);
      mutation.status = status;
      continue;
    }
    if (flag === PRIORITY_FLAG) {
      mutation.priority = parseQueuePriority(args[++index]);
      continue;
    }
    // Deferral flags. `--depends-on` is the machine-checkable hold the
    // autoscaler releases by itself; `--release-authority` is the hold no
    // predicate can evaluate and only a named person may lift. A row may carry
    // both, in which case the authority wins — a person's ruling is not
    // satisfied by its dependencies finishing.
    if (flag === DEPENDS_ON_FLAG) {
      const value = args[++index];
      if (value === undefined || value.trim() === "")
        throw new Error(
          `update-queue: ${DEPENDS_ON_FLAG} requires one or more comma-separated objective codes`,
        );
      dependsOn = value
        .split(",")
        .map((code) => code.trim().toLowerCase())
        .filter((code) => code !== "");
      if (dependsOn.length === 0)
        throw new Error(
          `update-queue: ${DEPENDS_ON_FLAG} requires one or more comma-separated objective codes`,
        );
      continue;
    }
    if (flag === RELEASE_AUTHORITY_FLAG) {
      const value = args[++index];
      if (value === undefined || value.trim() === "")
        throw new Error(
          `update-queue: ${RELEASE_AUTHORITY_FLAG} requires a name (e.g. Lord)`,
        );
      releaseAuthority = value.trim();
      continue;
    }
    if (flag === DEFER_REASON_FLAG) {
      const value = args[++index];
      if (value === undefined || value.trim() === "")
        throw new Error(`update-queue: ${DEFER_REASON_FLAG} requires text`);
      deferReason = value.trim();
      continue;
    }
    if (flag === ABSORBED_BY_OBJECTIVE_FLAG) {
      const absorbingObjectiveCode = queueAddressingObjectiveCode(
        args[++index] ?? "",
      );
      if (absorbingObjectiveCode === undefined)
        throw new Error(
          `update-queue: ${ABSORBED_BY_OBJECTIVE_FLAG} requires a valid objective code`,
        );
      mutation.absorption = {
        objectiveCode: absorbingObjectiveCode,
        deliveryCommit: null,
        targetRepo: null,
        targetBranch: null,
        treeIdentity: null,
        checkedAt: null,
        reason: "absorption awaiting reconciliation",
      };
      continue;
    }
    const bodyMode = flag === undefined ? undefined : BODY_FLAGS.get(flag);
    if (bodyMode !== undefined) {
      const value = args[++index];
      if (value === undefined)
        throw new Error(`update-queue: ${flag} requires a value`);
      refuseEmptyStringFieldValue(flag!, "body", value);
      if (bodyEdit !== undefined)
        throw new Error(
          "update-queue: pass exactly one body edit — --replace-body, --prepend-body or --append-body",
        );
      bodyEdit = { mode: bodyMode, text: value };
      if (flag === "--body") usedLegacyBodyFlag = true;
      continue;
    }
    const field = STRING_FIELDS.get(flag);
    if (field !== undefined) {
      const value = args[++index];
      if (value === undefined)
        throw new Error(`update-queue: ${flag} requires a value`);
      refuseEmptyStringFieldValue(flag, field, value);
      if (flag === "--agent-name") {
        const refusal = herdrAgentNameRefusal(value);
        if (refusal !== undefined)
          throw new Error(`update-queue: --agent-name refused: ${refusal}`);
      }
      mutation[field] = value;
      continue;
    }
    const clearField = CLEAR_FIELDS.get(flag);
    if (clearField !== undefined) {
      mutation[clearField] = null;
      continue;
    }
    throw new Error(`update-queue: unknown argument "${flag}"`);
  }
  if (objectiveCode === undefined)
    throw new Error("update-queue: a valid --objective-code is required");
  const deferring =
    dependsOn !== undefined ||
    releaseAuthority !== undefined ||
    deferReason !== undefined;
  if (deferring) {
    // Refused rather than inferred: silently flipping the status would make
    // `--depends-on` a second, undocumented way to defer, and a caller who
    // meant to amend an already-deferred row would not find out they had
    // instead re-deferred it.
    if (mutation.status !== RegentQueueItemStatus.Deferred)
      throw new Error(
        `update-queue: ${DEPENDS_ON_FLAG}/${RELEASE_AUTHORITY_FLAG}/${DEFER_REASON_FLAG} require --status deferred`,
      );
    mutation.deferral = {
      dependsOn: dependsOn ?? [],
      releaseAuthority: releaseAuthority ?? null,
      reason: deferReason ?? null,
    };
  } else if (mutation.status === RegentQueueItemStatus.Deferred) {
    // A hold with no condition at all can only be lifted by hand, and nothing
    // records why it exists. That is the exact failure this status replaced.
    throw new Error(
      `update-queue: --status deferred requires ${DEPENDS_ON_FLAG} (the objectives it waits on) ` +
        `or ${RELEASE_AUTHORITY_FLAG} (who must lift it). A hold with neither is invisible ` +
        `to the autoscaler's release pass and would sit until someone noticed it by hand.`,
    );
  }
  if (Object.keys(mutation).length === 0 && bodyEdit === undefined)
    throw new Error("update-queue: at least one mutable field is required");
  return {
    objectiveCode,
    mutation: mutation as QueueItemMutation,
    ...(bodyEdit === undefined ? {} : { bodyEdit }),
    ...(usedLegacyBodyFlag ? { usedLegacyBodyFlag } : {}),
  };
}

/**
 * The one place that decides whether a mutation touching
 * `agentName`/`targetRepo`/`baseCommit` on an item that will remain `open`
 * would leave it undispatchable. Pure — no store access. Two outcomes:
 * a pool release (the resulting `agentName` is `null`) re-stamps the
 * delivery mirror `not-started` unless the current mirror already reads
 * `delivered`; an unsafe partial strip (an agent stays assigned but the
 * resulting `targetRepo` or `baseCommit` is `null`) throws instead of
 * returning a mirror, naming the objective code, the assigned agent, and
 * the missing field. Any other mutation is a no-op and returns `undefined`.
 */
export function planLaunchMetadataConsistency(
  item: RegentQueueItemRow,
  mutation: QueueItemMutation,
  objectiveCode: string,
  now: () => number,
): QueueDeliveryMirror | undefined {
  const touchesLaunchMetadata =
    mutation.agentName !== undefined ||
    mutation.targetRepo !== undefined ||
    mutation.baseCommit !== undefined;
  if (!touchesLaunchMetadata) return undefined;
  const resultingStatus = mutation.status ?? item.status;
  if (resultingStatus !== RegentQueueItemStatus.Open) return undefined;

  const resultingAgentName =
    mutation.agentName === undefined ? item.agentName : mutation.agentName;
  const resultingTargetRepo =
    mutation.targetRepo === undefined ? item.targetRepo : mutation.targetRepo;
  const resultingBaseCommit =
    mutation.baseCommit === undefined ? item.baseCommit : mutation.baseCommit;

  if (resultingAgentName === null) {
    if (item.deliveryMirror.verdict === "delivered") return undefined;
    return {
      verdict: "not-started",
      deliveryCommit: null,
      targetRepo: resultingTargetRepo,
      targetBranch: item.deliveryMirror.targetBranch,
      treeIdentity: null,
      checkedAt: now(),
      reason:
        "queue item's agent assignment was cleared by update-queue; no agent is currently assigned",
    };
  }

  const missingField =
    resultingTargetRepo === null
      ? "target repository"
      : resultingBaseCommit === null
        ? "base commit"
        : undefined;
  if (missingField !== undefined) {
    throw new Error(
      `queue objective "${objectiveCode}" still has agent "${resultingAgentName}" ` +
        `assigned; clearing its ${missingField} would leave it undispatchable`,
    );
  }
  return undefined;
}

/** Resolves a parsed body edit against the stored body. `prepend`/`append`
 *  keep the existing text and separate the two halves with a blank line, which
 *  is what a banner-plus-amendment wants; `replace` discards it. */
export function resolveBodyEdit(
  storedBody: string,
  edit: QueueBodyEdit,
): string {
  if (edit.mode === "replace") return edit.text;
  return edit.mode === "prepend"
    ? `${edit.text}\n\n${storedBody}`
    : `${storedBody}\n\n${edit.text}`;
}

export function updateQueueItem(
  store: RegentQueueMutationStore,
  input: UpdateQueueInput,
  now: () => number = Date.now,
): ReturnType<RegentQueueMutationStore["mutateItem"]> & {
  bodyReplacementNotice?: string;
} {
  const item = findQueueItemByObjectiveCode(store, input.objectiveCode);
  if (item === undefined)
    throw new Error(`queue objective "${input.objectiveCode}" does not exist`);
  let bodyReplacementNotice: string | undefined;
  let bodyMutation: { body?: string } = {};
  if (input.bodyEdit !== undefined) {
    const nextBody = resolveBodyEdit(item.body, input.bodyEdit);
    bodyMutation = { body: nextBody };
    if (input.bodyEdit.mode === "replace") {
      bodyReplacementNotice = describeReplacedBody(item.body, nextBody);
    }
  }
  const deliveryMirror = planLaunchMetadataConsistency(
    item,
    input.mutation,
    input.objectiveCode,
    now,
  );
  const mutation: QueueItemMutation =
    deliveryMirror === undefined
      ? { ...input.mutation, ...bodyMutation }
      : { ...input.mutation, ...bodyMutation, deliveryMirror };
  if (input.mutation.absorption !== undefined) {
    if (item.status !== RegentQueueItemStatus.Open)
      throw new Error(
        `queue objective "${input.objectiveCode}" is "${item.status}", not "open"`,
      );
    const absorbingObjectiveCode = input.mutation.absorption?.objectiveCode;
    if (absorbingObjectiveCode === input.objectiveCode)
      throw new Error(
        `queue objective "${input.objectiveCode}" cannot absorb itself`,
      );
    if (absorbingObjectiveCode !== undefined) {
      const absorber = findQueueItemByObjectiveCode(
        store,
        absorbingObjectiveCode,
      );
      if (absorber === undefined)
        throw new Error(
          `absorbing queue objective "${absorbingObjectiveCode}" does not exist`,
        );
      if (
        absorber.status !== RegentQueueItemStatus.Open &&
        absorber.status !== RegentQueueItemStatus.InFlight
      )
        throw new Error(
          `absorbing queue objective "${absorbingObjectiveCode}" is not live`,
        );
    }
  }
  const updated = store.mutateItem(item.id, mutation);
  return bodyReplacementNotice === undefined
    ? updated
    : { ...updated, bodyReplacementNotice };
}

export async function run(
  args: string[],
  openStore: () => RegentQueueMutationStore = openRegentQueueStore,
): Promise<number> {
  let store: RegentQueueMutationStore | undefined;
  try {
    const input = parseUpdateQueueArgs(args);
    store = openStore();
    const item = updateQueueItem(store, input);
    process.stdout.write(`update-queue: updated "${item.objectiveCode}".\n`);
    if (input.usedLegacyBodyFlag) {
      process.stderr.write(
        "update-queue: --body REPLACES the stored body. It is kept as an alias; " +
          "prefer --replace-body, or --prepend-body / --append-body to amend " +
          "without discarding what is already there.\n",
      );
    }
    if (item.bodyReplacementNotice !== undefined) {
      process.stderr.write(`update-queue: ${item.bodyReplacementNotice}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(
      `${renderEntranceRefusal({
        reason: "update-queue entrance validation rejected the requested queue mutation.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return 1;
  } finally {
    store?.close();
  }
}
