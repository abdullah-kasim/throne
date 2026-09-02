// Merges a coding worktree's branch back into its recorded merge target — the
// other half of `spawn-git-tree`. The tree's `tree-base.json` names the target
// repo AND the branch to merge into; a campaign Shadow's record names its
// supervising Alpha's branch, so the whole campaign accumulates there instead
// of braiding into whatever branch the root checkout happens to have current.
// Uses the shared Git lifecycle `mergeBack`: validate a complete merged tree, create one
// commit parented by the latest target, then fast-forward/CAS while preserving
// a dirty checkout and the candidate ref. Creating the tree is
// `spawn-git-tree`; closing the loop is this command.
import { mergeBack, stampNoopDelivery } from "../git-lifecycle/delivery.ts";
import type { MergeBackResult } from "../git-lifecycle/delivery.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { LedgerDataService } from "../agentdata/ledger-data.service.ts";
import {
  readSpawnSpec as realReadSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { findInternalsToken } from "../git-lifecycle/squash-internals-check.ts";
import { InternalsMessageError } from "../git-lifecycle/squash.ts";
import {
  absorbTargetIntoCandidate,
  type AbsorbTargetResult,
} from "../git-lifecycle/absorb-and-stamp.ts";
import {
  proveTerminalAbsorbNoopCompletion,
  type TerminalAbsorbNoopDecision,
} from "./terminal-absorb-noop.ts";
import { checkValidateDeliveryVerdict } from "../validate-delivery/validate-delivery-runtime.ts";
import {
  markDeliveryValidationRequired,
  notifyDeliveryValidationRequired,
  withTargetDeliveryLock,
} from "./merge-git-tree-transaction.ts";
export { withTargetDeliveryLock } from "./merge-git-tree-transaction.ts";
import type { TreeMergeTarget } from "./merge-git-tree-contracts.ts";
export type { TreeMergeTarget } from "./merge-git-tree-contracts.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import {
  decideReportBackedNoChangePublication,
  type ReportBackedNoChangeDecision,
} from "./report-backed-no-change.ts";
import {
  isDeliveryGateNoopExempt,
  isNoopExemptFromWlsRefusal,
} from "./noop-exemptions.ts";
export {
  isDeliveryGateNoopExempt,
  isNoopExemptFromWlsRefusal,
} from "./noop-exemptions.ts";

const LEDGER_DATA = new LedgerDataService();
const USAGE =
  "Usage: ./bin/throne-cli merge-git-tree [--data-dir <path>] <name> <message>\n" +
  "       ./bin/throne-cli merge-git-tree --validate-message <message>\n";

interface Parsed {
  dataDir?: string;
  name?: string;
  message?: string;
  validateOnly?: boolean;
}

/** Parse the positional `<name>` — the tree/branch to merge back — and the
 *  explicit `<message>` required by the delivery command. Mirrors
 *  `make-squash-commit`'s `parseArgs`: everything after `<name>` (and any
 *  recognised flags) joins back with a single space, so a caller need not
 *  quote-escape internal spaces beyond ordinary shell quoting of the whole
 *  message. Parsing leaves an omitted message unset so `run` can report the
 *  mandatory pre-delivery validation failure before reading repository state. */
export function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {};
  const messageWords: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (parsed.name !== undefined || parsed.validateOnly === true) {
      messageWords.push(arg);
      continue;
    }
    if (arg === "--data-dir") {
      const dataDir = args[++i];
      if (dataDir === undefined || dataDir.startsWith("--")) {
        throw new Error('missing value for "--data-dir"');
      }
      parsed.dataDir = dataDir;
    } else if (arg === "--validate-message") {
      parsed.validateOnly = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag "${arg}"`);
    } else {
      parsed.name = arg;
    }
  }
  if (messageWords.length > 0) parsed.message = messageWords.join(" ");
  return parsed;
}

export type DeliveryMessageValidation =
  | { readonly valid: true; readonly message: string }
  | { readonly valid: false; readonly error: string };

/** Validate the explicit delivery message without reading or changing delivery
 * state. Normal delivery and `--validate-message` both use this decision. */
export function validateDeliveryMessage(
  message: string | undefined,
): DeliveryMessageValidation {
  if (message === undefined || message.trim() === "") {
    return {
      valid: false,
      error:
        "missing delivery message — the message is REQUIRED, never invented.",
    };
  }

  const hit = findInternalsToken(message);
  if (hit !== undefined) {
    return {
      valid: false,
      error: new InternalsMessageError(hit).message,
    };
  }

  return { valid: true, message };
}

/**
 * Resolve a tree's recorded merge target — the `repo` and `branch` fields of
 * its `tree-base.json`. Each field degrades to `undefined` independently when
 * absent or unusable (legacy record, no record, empty/non-string branch);
 * `run` then FAILS CLOSED: a merge with no usable recorded target refuses
 * instead of guessing a repo or landing on whatever branch is current, which
 * is how campaign work historically braided into unrelated branches. The real
 * reader behind the injectable `readTreeMergeTarget` seam. `readTreeBase` is
 * tolerant (returns null, never throws), so this never crashes a merge.
 */
export const realReadTreeMergeTarget = async (
  name: string,
  dataDir?: string,
): Promise<TreeMergeTarget> => {
  const record = await TREE_BASE_DATA.read(name, dataDir);
  const branch: unknown = record?.branch;
  return {
    ...(record?.repo === undefined ? {} : { repo: record.repo }),
    ...(typeof branch === "string" && branch !== "" ? { branch } : {}),
  };
};

/**
 * Real default for `isCompletedAgent`: has the named agent already reported
 * completion? Reads the exact same ledger `reap-agent` reads via
 * `listCompletedAgents` — no second completion-detection mechanism.
 */
const realIsCompletedAgent = async (name: string): Promise<boolean> =>
  (await LEDGER_DATA.listCompletedAgents()).includes(name);

/**
 * Is `name`'s `completed && noop` merge exempt from the WLS lost-commit
 * refusal? PRIMARY signal: its own `spawn.json` declares
 * `deliverable_shape === "verdict-only"` — set once, at spawn time, by
 * whoever assigned the work (`create-agent`), and read here by the bare
 * agent name with no Shadow/Alpha branch, so a verdict-gate Shadow and an
 * answer-only Alpha are exempted by the identical check. FALLBACK (retained,
 * legacy): `isTerminalGateShadowName(name)`, kept only for agents spawned
 * before `deliverable_shape` existed — see that function's doc comment for
 * its own residual and retirement criteria. Either signal alone is
 * sufficient; the refusal fires only when both are false.
 */
/**
 * Injectable seams. `mergeBack` merges a tree's branch into its target repo and
 * branch, reporting the branch it actually merged into; `readTreeMergeTarget`
 * resolves that recorded target (both default to the real implementations;
 * tests pass spies). `readTreeMergeTarget` is OPTIONAL so a partial
 * `{ mergeBack }` deps object still type-checks — `run` coalesces a missing one
 * to the real reader. `isCompletedAgent` is likewise OPTIONAL, consulted only
 * on a `noop: true` merge result to distinguish a legitimate re-run from the
 * WLS defect signature (DONE claimed, nothing landed) — except when
 * `isNoopExemptFromWlsRefusal` holds (property-keyed `spawn.json` signal, or
 * the retained name-keyed fallback), whose own pre-merge `REPORT.md` makes
 * it read as "completed" by design on a genuinely clean, zero-diff verdict;
 * see `terminal-gate-shadow.ts`. `readSpawnSpec` is likewise OPTIONAL,
 * consulted on the same `noop: true` branch to read the property-keyed
 * signal. `out`/`err` are injected output sinks (default:
 * `process.stdout`/`process.stderr`) so tests capture output as plain arrays
 * instead of swapping the global streams, which corrupts node:test's
 * reporter.
 */
export interface MergeGitTreeDeps {
  mergeBack?: (
    name: string,
    projectDir: string,
    targetBranch: string,
    message?: string,
    dataDir?: string,
  ) => Promise<MergeBackResult>;
  readTreeMergeTarget?: (
    name: string,
    dataDir?: string,
  ) => Promise<TreeMergeTarget>;
  isCompletedAgent?: (name: string) => Promise<boolean>;
  readSpawnSpec?: (name: string, dataDir?: string) => Promise<SpawnSpec | null>;
  isDeliveryGateNoopExempt?: (
    name: string,
    dataDir: string | undefined,
  ) => Promise<boolean>;
  decideReportBackedNoChangePublication?: (
    name: string,
    dataDir: string,
    target: TreeMergeTarget,
  ) => Promise<ReportBackedNoChangeDecision>;
  proveTerminalAbsorbNoopCompletion?: (
    name: string,
    dataDir: string | undefined,
  ) => Promise<TerminalAbsorbNoopDecision>;
  stampNoopDelivery?: (
    name: string,
    projectDir: string,
    targetBranch: string,
    message: string,
    dataDir?: string,
  ) => Promise<string>;
  withTargetDeliveryLock?: <T>(
    targetRepo: string,
    holder: string,
    dataDir: string | undefined,
    operation: () => Promise<T>,
    log: (message: string) => void,
  ) => Promise<T>;
  absorbDeliveryTarget?: (
    candidateBranch: string,
    targetRepo: string,
    targetBranch: string,
  ) => Promise<AbsorbTargetResult>;
  markValidationRequired?: (
    name: string,
    dataDir: string | undefined,
  ) => Promise<void>;
  notifyValidationRequired?: (name: string) => Promise<void>;
  validateDelivery?: (
    repoPath: string,
    commitHash: string,
    targetBranch: string,
  ) => ReturnType<typeof checkValidateDeliveryVerdict>;
  out?: (message: string) => void;
  err?: (message: string) => void;
}

export async function run(
  args: string[],
  deps: MergeGitTreeDeps = {},
): Promise<number> {
  const executeMergeBack = deps.mergeBack ?? mergeBack;
  const out =
    deps.out ?? ((message: string): void => void process.stdout.write(message));
  const err =
    deps.err ?? ((message: string): void => void process.stderr.write(message));

  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (parseErr) {
    err(
      `merge-git-tree: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n${renderEntranceRefusal(
        {
          reason: "merge-git-tree entrance validation refused this invocation.",
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor for an allowed alternative invocation.",
        },
      )}\n${USAGE}`,
    );
    return 1;
  }

  if (parsed.validateOnly === true) {
    const validation = validateDeliveryMessage(parsed.message);
    if (!validation.valid) {
      err(
        `merge-git-tree: ${validation.error}\n${renderEntranceRefusal({ reason: "merge-git-tree entrance validation requires a valid delivery message.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n${USAGE}`,
      );
      return 1;
    }
    out("merge-git-tree: delivery message is valid\n");
    return 0;
  }

  if (parsed.name === undefined) {
    err(
      `merge-git-tree: missing <name>\n${renderEntranceRefusal({ reason: "merge-git-tree entrance validation requires <name>.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n${USAGE}`,
    );
    return 1;
  }
  const name = parsed.name;

  const messageValidation = validateDeliveryMessage(parsed.message);
  if (!messageValidation.valid) {
    err(
      `merge-git-tree: ${messageValidation.error}\n${renderEntranceRefusal({ reason: "merge-git-tree entrance validation requires a valid delivery message.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n${USAGE}`,
    );
    return 1;
  }
  const message = messageValidation.message;

  // Merge into the repo and branch this tree was recorded against. FAIL
  // CLOSED on a legacy/absent/unusable record: guessing "the throne repo,
  // whatever branch is current" is exactly how campaign work landed on
  // unrelated branches. The record can be repaired by hand
  // (data/<name>/tree-base.json) and the merge re-run.
  const target = await (deps.readTreeMergeTarget ?? realReadTreeMergeTarget)(
    name,
    parsed.dataDir,
  );
  if (target.repo === undefined || target.branch === undefined) {
    const missing = [
      ...(target.repo === undefined ? ["repo"] : []),
      ...(target.branch === undefined ? ["branch"] : []),
    ].join(" and ");
    err(
      `merge-git-tree: "${name}" has no usable recorded merge target ` +
        `(tree-base.json is absent, legacy, or lacks ${missing}) — refusing ` +
        "to guess a target. Repair data/" +
        `${name}/tree-base.json (fields: repo, branch) and re-run, or merge ` +
        "by hand. Nothing was merged.\n",
    );
    return 1;
  }

  return (deps.withTargetDeliveryLock ?? withTargetDeliveryLock)(
    target.repo,
    name,
    parsed.dataDir,
    async () => {
      const absorb = await (
        deps.absorbDeliveryTarget ?? absorbTargetIntoCandidate
      )(name, target.repo!, target.branch!);
      if (absorb.status === "conflict") {
        err(
          `merge-git-tree: target absorb conflicted: ${absorb.reason}. ` +
            "final delivery FAILED; rerun initial target synchronization to resolve the conflict.\n",
        );
        return 1;
      }
      if (absorb.status === "merged-content") {
        // A non-campaign agent has no queue row, so the mark is a no-op for
        // it — but the notify below still fires, because the absorb happened
        // and somebody should hear about it. See the note on
        // `markDeliveryValidationRequired`.
        await (deps.markValidationRequired ?? markDeliveryValidationRequired)(
          name,
          parsed.dataDir,
        );
        try {
          await (
            deps.notifyValidationRequired ?? notifyDeliveryValidationRequired
          )(name);
        } catch (error) {
          err(
            `merge-git-tree: validation-required is durable, but notification failed: ` +
              `${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }

      const result = await executeMergeBack(
        name,
        target.repo!,
        target.branch!,
        message,
        parsed.dataDir,
      );
      let deliveredCommit: string;
      if (result.noop) {
        const completed = await (deps.isCompletedAgent ?? realIsCompletedAgent)(
          name,
        );
        const spawnSpec = await (deps.readSpawnSpec ?? realReadSpawnSpec)(
          name,
          parsed.dataDir,
        );
        const absorbNoopDecision = await (
          deps.proveTerminalAbsorbNoopCompletion ??
          proveTerminalAbsorbNoopCompletion
        )(name, parsed.dataDir);
        const oldNoopExemption = isNoopExemptFromWlsRefusal(name, spawnSpec);
        const deliveryGateExemption = oldNoopExemption
          ? false
          : await (deps.isDeliveryGateNoopExempt ?? isDeliveryGateNoopExempt)(
              name,
              parsed.dataDir,
            );
        const reportDecision =
          completed &&
          !oldNoopExemption &&
          !absorbNoopDecision.exempt &&
          !deliveryGateExemption
            ? await (
                deps.decideReportBackedNoChangePublication ??
                decideReportBackedNoChangePublication
              )(name, parsed.dataDir ?? DEFAULT_DATA_DIR, target)
            : { accepted: false as const, reason: "not consulted" };
        if (
          completed &&
          !oldNoopExemption &&
          !absorbNoopDecision.exempt &&
          !deliveryGateExemption &&
          !reportDecision.accepted
        ) {
          err(
            `merge-git-tree: "${name}" reported DONE but has no net change ` +
              `against branch "${result.branch}" — one of the two claims is ` +
              "wrong. Refusing to treat this as success. Investigate whether " +
              "the agent's commit was actually made before reaping its " +
              `branch. REPORT-backed completion refused: ${reportDecision.reason}.` +
              (absorbNoopDecision.reason === undefined
                ? "\n"
                : ` 99a absorb proof failed: ${absorbNoopDecision.reason}.\n`),
          );
          return 1;
        }
        if (result.message === undefined || result.message.trim() === "") {
          err(
            `merge-git-tree: missing delivery message — the message is REQUIRED, never invented. Try:\n` +
              `  ./bin/throne-cli merge-git-tree ${name} "<what this campaign delivered>"\n`,
          );
          return 1;
        }
        const stampCommit = await (deps.stampNoopDelivery ?? stampNoopDelivery)(
          name,
          target.repo!,
          target.branch!,
          result.message,
          parsed.dataDir,
        );
        if (result.preSquashSha !== undefined) {
          out(
            `pre-squash SHA (candidate tip, unchanged): ${result.preSquashSha}\n`,
          );
        }
        out(
          `"${name}" has no net change against branch "${result.branch}"; ` +
            `published completion stamp ${stampCommit}\n`,
        );
        deliveredCommit = stampCommit;
      } else {
        out(
          `delivered "${name}" to branch "${result.branch}" as commit ${result.commit}\n`,
        );
        if (result.preSquashSha !== undefined) {
          out(
            `pre-squash SHA (candidate tip, unchanged): ${result.preSquashSha}\n`,
          );
        }
        if (result.commit === undefined) {
          throw new Error("merge-git-tree: delivery returned no commit");
        }
        deliveredCommit = result.commit;
      }
      const validate =
        deps.validateDelivery ??
        ((repoPath: string, commitHash: string, targetBranch: string) =>
          checkValidateDeliveryVerdict(repoPath, commitHash, {
            currentBranch: async () => targetBranch,
          }));
      const verdict = await validate(
        target.repo!,
        deliveredCommit,
        target.branch!,
      );
      if (verdict.status !== "delivered") {
        err(
          `merge-git-tree: NOT DELIVERED after publication; validate-delivery ` +
            `reported ${verdict.status}.\n`,
        );
        return 1;
      }
      out(
        `merge-git-tree: validate-delivery independently proved ${deliveredCommit}\n`,
      );
      return 0;
    },
    err,
  );
}
