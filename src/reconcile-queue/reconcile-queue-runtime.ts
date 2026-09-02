import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import type {
  QueueAbsorption,
  QueueDeliveryMirror,
  RegentQueueItemRow,
  RegentQueueMutationStore,
} from "../regent-queue/regent-queue.store.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { findDeliveryCommitHashes } from "../git-lifecycle/delivery-commit-proof.ts";
import { localBranchTip } from "../git-lifecycle/branch-authority.ts";
import { readRevisionTreeIdentity } from "../git-lifecycle/path-wise-delivery.ts";
import {
  readGitStatus,
  repoRoot,
} from "../git-lifecycle/git-command.service.ts";
import { isThroneCheckout } from "../throne-root-resolution.ts";
import {
  parseUpdateQueueArgs,
  updateQueueItem,
} from "../update-queue/update-queue-runtime.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

export function parseReconcileQueueArgs(args: string[]) {
  const absorbedIndex = args.indexOf("--absorbed-by");
  const deliveryIndex = args.indexOf("--delivery-commit");
  const absorbedBy = absorbedIndex < 0 ? undefined : args[absorbedIndex + 1];
  const deliveryCommit =
    deliveryIndex < 0 ? undefined : args[deliveryIndex + 1];
  if (!absorbedBy || !deliveryCommit)
    throw new Error(
      "reconcile-queue: --absorbed-by and --delivery-commit are required",
    );
  const objectiveArgs = args.filter(
    (_, index) =>
      index !== absorbedIndex &&
      index !== absorbedIndex + 1 &&
      index !== deliveryIndex &&
      index !== deliveryIndex + 1,
  );
  const parsed = parseUpdateQueueArgs([
    ...objectiveArgs,
    "--status",
    RegentQueueItemStatus.Complete,
  ]);
  return {
    ...parsed,
    mutation: { ...parsed.mutation, agentName: absorbedBy, deliveryCommit },
  };
}

export interface ReconcileQueueTreeDeps {
  readonly now?: () => number;
  readonly repoRoot?: typeof repoRoot;
  readonly localBranchTip?: typeof localBranchTip;
  readonly findDeliveryCommitHashes?: typeof findDeliveryCommitHashes;
  readonly readRevisionTreeIdentity?: typeof readRevisionTreeIdentity;
  readonly readReachability?: typeof readGitStatus;
}

function unknownMirror(
  reason: string,
  checkedAt: number,
  evidence: Partial<
    Pick<
      QueueDeliveryMirror,
      "deliveryCommit" | "targetRepo" | "targetBranch" | "treeIdentity"
    >
  > = {},
): QueueDeliveryMirror {
  return {
    verdict: "unknown",
    deliveryCommit: evidence.deliveryCommit ?? null,
    targetRepo: evidence.targetRepo ?? null,
    targetBranch: evidence.targetBranch ?? null,
    treeIdentity: evidence.treeIdentity ?? null,
    checkedAt,
    reason,
  };
}

function notStartedMirror(
  checkedAt: number,
  targetRepo: string,
  targetBranch: string,
): QueueDeliveryMirror {
  return {
    verdict: "not-started",
    deliveryCommit: null,
    targetRepo,
    targetBranch,
    treeIdentity: null,
    checkedAt,
    reason: "no agent is assigned yet; work has not started",
  };
}

function isOpenOrInFlight(item: RegentQueueItemRow): boolean {
  return (
    item.status === RegentQueueItemStatus.Open ||
    item.status === RegentQueueItemStatus.InFlight
  );
}

// A mainline delivery (no PR, so no `prBranch`) has no branch source of its
// own to fall back to. Guessing an arbitrary repository's actual default
// branch would require a git call this resolver deliberately never makes
// (see `durableDefaultBranch` in branch-authority.ts, which stays unwired
// here). The one repository this codebase already commits to elsewhere as
// mainline-is-"main" is the throne repository itself, so that is the only
// case this resolver defaults for; every other repository still refuses,
// naming the branch as missing rather than guessing at it.
function resolveRecordedCoordinates(item: RegentQueueItemRow): {
  targetRepo?: string;
  targetBranch?: string;
  agentName?: string;
} {
  const targetRepo =
    item.targetRepo ?? item.launchEligibility?.targetRepo ?? undefined;
  const recordedBranch =
    item.prBranch ?? item.launchEligibility?.targetBranch ?? undefined;
  return {
    targetRepo,
    targetBranch:
      recordedBranch ??
      (targetRepo !== undefined && isThroneCheckout(targetRepo)
        ? "main"
        : undefined),
    agentName: item.agentName ?? item.launchEligibility?.alphaName ?? undefined,
  };
}

function unknownAbsorption(
  objectiveCode: string,
  reason: string,
  checkedAt: number,
  mirror?: QueueDeliveryMirror,
): QueueAbsorption {
  return {
    objectiveCode,
    deliveryCommit: mirror?.deliveryCommit ?? null,
    targetRepo: mirror?.targetRepo ?? null,
    targetBranch: mirror?.targetBranch ?? null,
    treeIdentity: mirror?.treeIdentity ?? null,
    checkedAt,
    reason,
  };
}

function liveAbsorption(
  objectiveCode: string,
  checkedAt: number,
): QueueAbsorption {
  return {
    objectiveCode,
    deliveryCommit: null,
    targetRepo: null,
    targetBranch: null,
    treeIdentity: null,
    checkedAt,
    reason: null,
  };
}

function deliveredAbsorption(
  objectiveCode: string,
  mirror: QueueDeliveryMirror,
): QueueAbsorption {
  return {
    objectiveCode,
    deliveryCommit: mirror.deliveryCommit,
    targetRepo: mirror.targetRepo,
    targetBranch: mirror.targetBranch,
    treeIdentity: mirror.treeIdentity,
    checkedAt: mirror.checkedAt,
    reason: null,
  };
}

export async function deriveQueueDeliveryMirror(
  item: RegentQueueItemRow,
  deps: ReconcileQueueTreeDeps = {},
): Promise<QueueDeliveryMirror> {
  const checkedAt = (deps.now ?? Date.now)();
  const coordinates = resolveRecordedCoordinates(item);
  if (
    coordinates.targetRepo === undefined ||
    coordinates.targetBranch === undefined
  ) {
    const missing = [
      ...(coordinates.targetRepo === undefined ? ["target repository"] : []),
      ...(coordinates.targetBranch === undefined ? ["target branch"] : []),
    ];
    return unknownMirror(
      `delivery metadata lacks ${missing.join(" and ")}`,
      checkedAt,
      {
        deliveryCommit: item.deliveryCommit,
        targetRepo: coordinates.targetRepo,
        targetBranch: coordinates.targetBranch,
      },
    );
  }

  try {
    const root = await (deps.repoRoot ?? repoRoot)(coordinates.targetRepo);
    // A row can be earmarked to eventually launch under a given Alpha
    // (`launchEligibility.alphaName`, folded into `coordinates.agentName`
    // below) long before that launch actually happens. That earmark proves
    // nothing about whether work has started, so never-started must key off
    // the raw dispatch column instead: `item.agentName` stays null until a
    // real launch or delivery recording sets it.
    if (item.deliveryCommit === null && item.agentName === null) {
      return notStartedMirror(checkedAt, root, coordinates.targetBranch);
    }
    const commits =
      item.deliveryCommit === null
        ? await (deps.findDeliveryCommitHashes ?? findDeliveryCommitHashes)(
            coordinates.agentName!,
            root,
          )
        : [item.deliveryCommit];
    if (commits.length === 0) {
      return unknownMirror(
        "no delivery commit can be resolved from recorded evidence",
        checkedAt,
        {
          targetRepo: root,
          targetBranch: coordinates.targetBranch,
        },
      );
    }
    if (commits.length > 1) {
      return unknownMirror(
        `delivery discovery is ambiguous: ${commits.length} matching commits`,
        checkedAt,
        { targetRepo: root, targetBranch: coordinates.targetBranch },
      );
    }

    const deliveryCommit = commits[0]!;
    const branchTip = await (deps.localBranchTip ?? localBranchTip)(
      root,
      coordinates.targetBranch,
    );
    if (branchTip === undefined) {
      return unknownMirror(
        `target branch "${coordinates.targetBranch}" does not exist`,
        checkedAt,
        {
          deliveryCommit,
          targetRepo: root,
          targetBranch: coordinates.targetBranch,
        },
      );
    }
    const commitStatus = await (deps.readReachability ?? readGitStatus)(
      ["cat-file", "-e", `${deliveryCommit}^{commit}`],
      root,
    );
    if (commitStatus.code !== 0) {
      return unknownMirror(
        `delivery commit "${deliveryCommit}" cannot be read`,
        checkedAt,
        {
          deliveryCommit,
          targetRepo: root,
          targetBranch: coordinates.targetBranch,
        },
      );
    }
    const reachability = await (deps.readReachability ?? readGitStatus)(
      ["merge-base", "--is-ancestor", deliveryCommit, branchTip],
      root,
    );
    const identity = await (
      deps.readRevisionTreeIdentity ?? readRevisionTreeIdentity
    )(root, deliveryCommit, branchTip);
    if (reachability.code === 0) {
      return {
        verdict: "delivered",
        deliveryCommit,
        targetRepo: root,
        targetBranch: coordinates.targetBranch,
        treeIdentity: identity.candidateTree,
        checkedAt,
        reason: null,
      };
    }
    if (reachability.code === 1) {
      return {
        verdict: "not-delivered",
        deliveryCommit,
        targetRepo: root,
        targetBranch: coordinates.targetBranch,
        treeIdentity: identity.candidateTree,
        checkedAt,
        reason: `delivery commit is not reachable from target branch "${coordinates.targetBranch}"`,
      };
    }
    return unknownMirror(
      `git reachability read failed: ${reachability.stderr.trim() || `exit ${reachability.code}`}`,
      checkedAt,
      {
        deliveryCommit,
        targetRepo: root,
        targetBranch: coordinates.targetBranch,
        treeIdentity: identity.candidateTree,
      },
    );
  } catch (error) {
    return unknownMirror(
      `delivery evidence read failed: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
    );
  }
}

export async function reconcileQueueTreeEvidence(
  store: RegentQueueMutationStore,
  deps: ReconcileQueueTreeDeps = {},
): Promise<RegentQueueItemRow[]> {
  const read = store.readAll();
  if (read.state === "unknown") throw new Error(read.reason);
  if (read.state === "positively-empty") return [];
  const reconciled: RegentQueueItemRow[] = [];
  const itemsByObjectiveCode = new Map(
    read.items.flatMap((item) =>
      item.objectiveCode === null ? [] : [[item.objectiveCode, item] as const],
    ),
  );
  for (const item of read.items.filter(isOpenOrInFlight)) {
    const deliveryMirror = await deriveQueueDeliveryMirror(item, deps);
    if (item.absorption === null) {
      reconciled.push(store.mutateItem(item.id, { deliveryMirror }));
      continue;
    }
    const checkedAt = (deps.now ?? Date.now)();
    const absorber = itemsByObjectiveCode.get(item.absorption.objectiveCode);
    if (absorber === undefined) {
      reconciled.push(
        store.mutateItem(item.id, {
          deliveryMirror,
          absorption: unknownAbsorption(
            item.absorption.objectiveCode,
            `absorbing objective "${item.absorption.objectiveCode}" does not exist`,
            checkedAt,
          ),
        }),
      );
      continue;
    }
    if (absorber.status === RegentQueueItemStatus.Abandoned) {
      reconciled.push(
        store.mutateItem(item.id, { deliveryMirror, absorption: null }),
      );
      continue;
    }
    if (isOpenOrInFlight(absorber)) {
      reconciled.push(
        store.mutateItem(item.id, {
          deliveryMirror,
          absorption: liveAbsorption(item.absorption.objectiveCode, checkedAt),
        }),
      );
      continue;
    }
    const absorberMirror = await deriveQueueDeliveryMirror(absorber, deps);
    if (
      absorberMirror.verdict === "delivered" &&
      absorberMirror.deliveryCommit !== null
    ) {
      store.mutateItem(item.id, {
        deliveryMirror,
        absorption: deliveredAbsorption(
          item.absorption.objectiveCode,
          absorberMirror,
        ),
      });
      reconciled.push(
        updateQueueItem(store, {
          objectiveCode: item.objectiveCode!,
          mutation: {
            status: RegentQueueItemStatus.Complete,
            agentName: item.absorption.objectiveCode,
            deliveryCommit: absorberMirror.deliveryCommit,
            deliveryMirror,
          },
        }),
      );
      continue;
    }
    reconciled.push(
      store.mutateItem(item.id, {
        deliveryMirror,
        absorption: unknownAbsorption(
          item.absorption.objectiveCode,
          absorberMirror.reason ?? "absorber delivery evidence is unknown",
          checkedAt,
          absorberMirror,
        ),
      }),
    );
  }
  return reconciled;
}

export async function run(
  args: string[],
  openStore: () => RegentQueueMutationStore = openRegentQueueStore,
  deps: ReconcileQueueTreeDeps = {},
): Promise<number> {
  let store: RegentQueueMutationStore | undefined;
  try {
    if (args.length === 0) {
      store = openStore();
      const items = await reconcileQueueTreeEvidence(store, deps);
      for (const item of items) {
        process.stdout.write(
          `reconcile-queue: ${item.objectiveCode ?? item.id} ${item.deliveryMirror.verdict}.\n`,
        );
      }
      return 0;
    }
    // A mutation invocation must clear argument admission before opening the
    // store; invalid requests have no queue-read or write effect.
    const input = parseReconcileQueueArgs(args);
    store = openStore();
    const item = updateQueueItem(store, input);
    process.stdout.write(
      `reconcile-queue: completed "${item.objectiveCode}" via "${item.agentName}".\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${renderEntranceRefusal(
        {
          reason:
            "reconcile-queue entrance validation refused this invocation.",
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor for an allowed alternative invocation.",
        },
      )}\n`,
    );
    return 1;
  } finally {
    store?.close();
  }
}
