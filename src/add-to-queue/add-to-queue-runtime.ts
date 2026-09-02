// Writes one new open item to the Regent's SQLite queue store — and every item
// it writes is DEFINITELY dispatchable by the autoscaler. That is the whole
// contract: "on the queue" and "the autoscaler can act on it" must be the same
// fact, never two states an operator has to reconcile by hand.
//
// Two things previously made a freshly added item undispatchable, and both are
// closed here:
//
//   1. Launch metadata was optional, so an item could exist with no target
//      repository or branch. `classifyEffectiveQueueDecision` cannot tell such
//      an item apart from one already delivered, so it fails closed as
//      "delivery evidence is unknown". Missing fields are now derived from the
//      caller's checkout, and a derivation failure REFUSES the insert.
//   2. `insertItem` defaults `delivery_mirror_state` to "unknown", which is the
//      same hard refusal, and only a later `reconcile-queue` pass cleared it. A
//      brand-new item provably has no agent and no delivery, so it is now born
//      with a "not-started" mirror. That is not an optimistic guess — it is the
//      one verdict that is true by construction at insert time.

import {
  openRegentQueueStore,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import {
  canonicalObjectiveCode,
  isQueueFilerRoleName,
  nameCarriesObjectiveCode,
} from "../shared-policy/objective-contract.ts";
import {
  readAgentRole,
  IdentityLineReadStatus,
} from "../agentdata/identity-data.service.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { parseQueuePriority } from "../regent-queue/regent-queue-row.ts";
import { parseQueueModelHint } from "../regent-queue/model-hint.ts";
import type { ModelPair } from "../config.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { herdrAgentNameRefusal } from "../herdr/herdr-identity.service.ts";
import {
  defaultAlphaName,
  resolveGitLaunchDefaults,
  type LaunchDefaults,
} from "./launch-defaults.ts";

const OBJECTIVE_CODE_FLAG = "--objective-code";
const LAUNCH_FLAGS = new Set([
  "--alpha-name",
  "--target-repo",
  "--target-branch",
  "--base-commit",
]);
const PR_BRANCH_FLAG = "--pr-branch";
const PRIORITY_FLAG = "--priority";
const MODEL_HINT_FLAG = "--model-hint";

export interface LaunchMetadata {
  alphaName: string;
  targetRepo: string;
  targetBranch: string;
  baseCommit: string;
}

export type PartialLaunchMetadata = Partial<LaunchMetadata>;

export interface ParsedAddToQueueArgs {
  objectiveCode: string;
  /** Operator-supplied launch fields. Any field left out is derived from the
   *  caller's checkout by `resolveLaunchMetadata`; none of them is optional in
   *  the row that finally lands. */
  launchOverrides: PartialLaunchMetadata;
  /** Delivery lands on this PR branch (created from the mainline if absent); omitted = mainline delivery. */
  prBranch?: string;
  priority?: number;
  modelHint?: ModelPair;
  body: string;
}

export class MissingQueueItemBodyError extends Error {
  readonly name = "MissingQueueItemBodyError";
  constructor() {
    super(
      `add-to-queue: no item body given — pass the queue item's prose as the ` +
        `remaining argument(s), optionally preceded by "${OBJECTIVE_CODE_FLAG} <code>".`,
    );
  }
}

/** Parses `[--objective-code <code>] <body words...>` into a body string and
 *  an optional objective code. The flag may appear anywhere among the
 *  arguments; every non-flag word joins the body, space-separated. */
export function parseAddToQueueArgs(args: string[]): ParsedAddToQueueArgs {
  let objectiveCode: string | undefined;
  let prBranch: string | undefined;
  let priority: number | undefined;
  let modelHint: ModelPair | undefined;
  const launchValues: Record<string, string> = {};
  const bodyWords: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === OBJECTIVE_CODE_FLAG) {
      const value = args[i + 1];
      objectiveCode =
        value === undefined ? undefined : canonicalObjectiveCode(value);
      if (objectiveCode === undefined)
        throw new Error(
          `add-to-queue: invalid objective code "${value ?? ""}"`,
        );
      i++;
      continue;
    }
    if (args[i] === PR_BRANCH_FLAG) {
      const value = args[++i];
      if (value === undefined || value.trim() === "")
        throw new Error(
          `add-to-queue: ${PR_BRANCH_FLAG} requires a branch name`,
        );
      prBranch = value.trim();
      continue;
    }
    if (args[i] === PRIORITY_FLAG) {
      priority = parseQueuePriority(args[++i]);
      continue;
    }
    if (args[i] === MODEL_HINT_FLAG) {
      modelHint = parseQueueModelHint(args[++i]);
      continue;
    }
    if (LAUNCH_FLAGS.has(args[i]!)) {
      const value = args[++i];
      if (value === undefined || value.trim() === "")
        throw new Error(`add-to-queue: ${args[i - 1]} requires a value`);
      launchValues[args[i - 1]!.slice(2)] = value;
      continue;
    }
    bodyWords.push(args[i]);
  }
  const body = bodyWords.join(" ").trim();
  if (body.length === 0) {
    throw new MissingQueueItemBodyError();
  }
  const launchOverrides: PartialLaunchMetadata = {
    ...(launchValues["alpha-name"] === undefined
      ? {}
      : { alphaName: launchValues["alpha-name"] }),
    ...(launchValues["target-repo"] === undefined
      ? {}
      : { targetRepo: launchValues["target-repo"] }),
    ...(launchValues["target-branch"] === undefined
      ? {}
      : { targetBranch: launchValues["target-branch"] }),
    ...(launchValues["base-commit"] === undefined
      ? {}
      : { baseCommit: launchValues["base-commit"] }),
  };
  if (objectiveCode === undefined)
    throw new Error(
      `add-to-queue: ${OBJECTIVE_CODE_FLAG} is required — an item without an ` +
        `objective code can never be launch-eligible, and this command only ` +
        `mints dispatchable items.`,
    );
  // --target-repo IS MANDATORY (the Lord, 2026-08-27: "add-to-queue requires a
  // mandatory target repo"). It used to default to the FILER'S OWN CHECKOUT via
  // `git rev-parse --show-toplevel`, which is wrong essentially every time:
  // filing is Stager-only, and a Stager files objectives for OTHER repositories
  // from its own tree.
  //
  // Measured 2026-08-27, the incident that forced this: seven `the-runner`
  // objectives were filed from a Stager worktree and silently recorded
  // `launch_target_repo = .../worktrees/throne/stager-floor`, branch
  // `stager-floor`. Autoscale then tried to fork a the-runner campaign off the
  // Stager's own throne branch every five minutes while the Alpha floor sat
  // breached. The filer had "corrected" it with `update-queue --target-repo`,
  // but THAT FLAG WRITES A DIFFERENT COLUMN (`target_repo`, the delivery
  // evidence) than this one (`launch_target_repo`, what create-agent forks
  // from) — and `render-queue` prints the former, so the correction looked
  // applied and changed nothing. Requiring the value here is what removes the
  // silent default that made that possible.
  if (launchValues["target-repo"] === undefined)
    throw new Error(
      `add-to-queue: --target-repo is required. Name the repository this ` +
        `objective will be BUILT IN, absolutely — e.g. --target-repo ` +
        `/var/home/theuser/repos/the-runner. It is no longer derived from the ` +
        `current directory, because filing is Stager-only and a Stager files ` +
        `for other repositories from its own tree. --target-branch and ` +
        `--base-commit still default, but they are now read from the repo you ` +
        `name here rather than from wherever you are standing. No bypass ` +
        `exists. If the objective's SUBJECT has no git repository at all (a ` +
        `report or verdict over files outside version control), the subject ` +
        `is still not the target repo: name the repository the campaign is ` +
        `BUILT IN — for throne agents that is the live throne checkout ` +
        `itself — and carry the subject's absolute path in the body as data ` +
        `(the proven kir510b/kir220b/kir120b pattern). Creating a temporary ` +
        `blank repo under the agent's own storage (e.g. ~/.throne/data/` +
        `<agent>/) is also allowed, but note the Alpha's worktree is forked ` +
        `from the repo you name, so a blank repo yields a worktree without ` +
        `throne tooling.`,
    );
  return {
    objectiveCode,
    body,
    ...(prBranch === undefined ? {} : { prBranch }),
    ...(priority === undefined ? {} : { priority }),
    ...(modelHint === undefined ? {} : { modelHint }),
    launchOverrides,
  };
}

export interface AddToQueueDeps {
  openStore: () => RegentQueueStore;
  /** Who is invoking. Injectable so the gate is testable without a live herdr. */
  currentAgentName: () => Promise<string>;
  readRole: (name: string) => Promise<{
    status: IdentityLineReadStatus;
    value?: string;
  }>;
  /** Derives branch/base FROM THE NAMED TARGET REPO, never from the caller's
   *  cwd — the repo is now mandatory, so standing somewhere else must not leak
   *  a branch or a commit into the launch record. */
  resolveLaunchDefaults: (repoPath: string) => LaunchDefaults;
  now: () => number;
}

export const REAL_DEPS: AddToQueueDeps = {
  openStore: openRegentQueueStore,
  currentAgentName: resolveCurrentAgentName,
  readRole: (name) => readAgentRole(name),
  resolveLaunchDefaults: (repoPath: string) => resolveGitLaunchDefaults(repoPath),
  now: () => Date.now(),
};

/**
 * Only a Stager may file a queue objective (Lord, 2026-08-21). Fails CLOSED:
 * an unreadable or absent role is a refusal, never an admission, because the
 * whole point of the cap is that the Lord decides what the court works on and
 * an unidentifiable caller has not been shown to be him talking through his
 * Stager.
 */
async function refuseNonStagerFiler(
  deps: AddToQueueDeps,
): Promise<string | undefined> {
  let name: string;
  try {
    name = await deps.currentAgentName();
  } catch (err) {
    return `add-to-queue: could not resolve the calling agent (${
      err instanceof Error ? err.message : String(err)
    }) — filing is admitted only for a Stager, so an unidentifiable caller is refused.`;
  }

  const roleRead = await deps.readRole(name);
  if (roleRead.status !== IdentityLineReadStatus.Found) {
    return (
      `add-to-queue: "${name}" has no readable role (identity.md missing, ` +
      `unreadable, or carrying no Role line) — filing is admitted only for a Stager.`
    );
  }
  if (!isQueueFilerRoleName(roleRead.value ?? "")) {
    return (
      `add-to-queue: filing a queue objective is admitted only for a Stager; ` +
      `"${name}" is a ${roleRead.value}. The Lord caps what the court works on, ` +
      `and he sets that cap through the Stager. Report the finding to your ` +
      `supervisor and let the Lord decide whether it becomes an objective — ` +
      `routing it through a supervisor to file instead is the same outcome with ` +
      `an extra hop, and is equally refused. Nothing was added to the queue.`
    );
  }
  return undefined;
}

/** Completes the operator's partial launch fields FROM THE NAMED TARGET REPO.
 *  Throws rather than returning a hole: a hole is exactly the undispatchable
 *  item this command exists to stop minting. */
export function resolveLaunchMetadata(
  parsed: ParsedAddToQueueArgs,
  resolveLaunchDefaults: (repoPath: string) => LaunchDefaults,
): LaunchMetadata {
  const overrides = parsed.launchOverrides;
  // Parsing already refused a missing --target-repo, so this is present; the
  // check keeps the invariant local rather than trusting a caller two files
  // away.
  const targetRepo = overrides.targetRepo;
  if (targetRepo === undefined)
    throw new Error("add-to-queue: --target-repo is required");
  const needsDerivation =
    overrides.targetBranch === undefined || overrides.baseCommit === undefined;
  // Derived from the NAMED repo, not the caller's cwd: a Stager standing in its
  // own tree must not leak that tree's branch or HEAD into what create-agent
  // forks from.
  const derived = needsDerivation ? resolveLaunchDefaults(targetRepo) : undefined;
  const alphaName =
    overrides.alphaName ?? defaultAlphaName(parsed.objectiveCode, parsed.body);
  const herdrRefusal = herdrAgentNameRefusal(alphaName);
  if (herdrRefusal !== undefined) {
    throw new Error(`add-to-queue: refusing --alpha-name "${alphaName}" — ${herdrRefusal}`);
  }
  if (!nameCarriesObjectiveCode("alpha", alphaName, parsed.objectiveCode)) {
    throw new Error(
      `add-to-queue: refusing --alpha-name "${alphaName}" — it must begin ` +
        `"alpha-${parsed.objectiveCode}-" to carry the item's objective code`,
    );
  }
  return {
    alphaName,
    targetRepo,
    targetBranch: overrides.targetBranch ?? derived!.targetBranch,
    baseCommit: overrides.baseCommit ?? derived!.baseCommit,
  };
}

export async function run(
  args: string[],
  deps: AddToQueueDeps = REAL_DEPS,
): Promise<number> {
  let parsed: ParsedAddToQueueArgs;
  try {
    parsed = parseAddToQueueArgs(args);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stderr.write(
      `${renderEntranceRefusal({
        reason: "add-to-queue entrance validation rejected the supplied queue item arguments.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return 1;
  }

  // Who-may-file is checked BEFORE launch metadata is derived: a refused
  // caller should not cause a git probe of the caller's checkout, and the
  // cheaper refusal is also the one that fails closed.
  const refusal = await refuseNonStagerFiler(deps);
  if (refusal !== undefined) {
    process.stderr.write(`${refusal}\n`);
    return 1;
  }

  let launch: LaunchMetadata;
  try {
    launch = resolveLaunchMetadata(parsed, deps.resolveLaunchDefaults);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stderr.write(
      `${renderEntranceRefusal({
        reason:
          "add-to-queue refuses to mint a queue item the autoscaler could not dispatch.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return 1;
  }

  const store = deps.openStore();
  try {
    const item = store.insertItem({
      objectiveCode: parsed.objectiveCode,
      body: parsed.body,
      ...(parsed.prBranch === undefined ? {} : { prBranch: parsed.prBranch }),
      ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
      ...(parsed.modelHint === undefined ? {} : { modelHint: parsed.modelHint }),
      launch,
      deliveryMirror: {
        verdict: "not-started",
        deliveryCommit: null,
        targetRepo: launch.targetRepo,
        targetBranch: launch.targetBranch,
        treeIdentity: null,
        checkedAt: deps.now(),
        reason: "queue item was just created; no agent is assigned yet",
      },
    });
    process.stdout.write(
      `add-to-queue: added item "${item.id}" (status: ${item.status}, ` +
        `launch-eligible as ${launch.alphaName} against ` +
        `${launch.targetRepo} ${launch.targetBranch} @ ${launch.baseCommit.slice(0, 12)}).\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `add-to-queue: could not add item (${err instanceof Error ? err.message : String(err)}).\n`,
    );
    return 1;
  } finally {
    store.close();
  }
}
