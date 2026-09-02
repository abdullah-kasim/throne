// PREVIEW half of the Lord's one-commit delivery redesign (SQUASH). Builds
// the squashed commit `merge-git-tree` will eventually deliver, on a
// throwaway scratch ref, and STOPS — it never pushes, merges into the
// target, or touches the candidate or target branch. Delivering it is a
// later campaign's job; this command exists so a squash can be reviewed
// before anything depends on it being correct (see the SQUASH queue entry:
// "getting the merge behaviour wrong in a preview costs a scratch ref;
// getting it wrong in the delivery path costs main").
//
// Resolves the target branch from the SAME source `merge-git-tree` uses
// (`data/<name>/tree-base.json`, via the shared `realReadTreeMergeTarget`) —
// deliberately not a second target-resolution path.
import { repoRoot } from "../git-lifecycle/git-command.service.ts";
import {
  buildSquashPreview,
  InternalsMessageError,
  type SquashPreviewResult,
} from "../git-lifecycle/squash.ts";
import {
  realReadTreeMergeTarget,
  type TreeMergeTarget,
} from "../merge-git-tree/merge-git-tree-runtime.ts";
import {
  SQUASH_PREVIEW_DATA,
  type SquashPreviewRecord,
} from "../agentdata/squash-preview-data.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const USAGE =
  "Usage: ./bin/throne-cli make-squash-commit [--data-dir <path>] <name> <commit message>\n";

function entranceRefusal(reason: string): string {
  return `${renderEntranceRefusal({ reason, bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n`;
}

interface Parsed {
  dataDir?: string;
  name?: string;
  message?: string;
}

/** Parse `<name>` and the commit message — everything after `<name>` (and
 *  any recognised flags) joined back with a single space, so a caller need
 *  not quote-escape internal spaces beyond ordinary shell quoting of the
 *  whole message. */
export function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {};
  const messageWords: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (parsed.name !== undefined) {
      messageWords.push(arg);
      continue;
    }
    if (arg === "--data-dir") {
      const dataDir = args[++i];
      if (dataDir === undefined || dataDir.startsWith("--")) {
        throw new Error('missing value for "--data-dir"');
      }
      parsed.dataDir = dataDir;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag "${arg}"`);
    } else {
      parsed.name = arg;
    }
  }
  if (messageWords.length > 0) parsed.message = messageWords.join(" ");
  return parsed;
}

export interface MakeSquashCommitDeps {
  readTreeMergeTarget?: (name: string, dataDir?: string) => Promise<TreeMergeTarget>;
  resolveRoot?: (projectDir: string) => Promise<string>;
  buildSquashPreview?: (
    root: string,
    name: string,
    targetBranch: string,
    message: string,
  ) => Promise<SquashPreviewResult>;
  writePreviewRecord?: (
    name: string,
    record: SquashPreviewRecord,
    dataDir?: string,
  ) => Promise<void>;
  now?: () => string;
  out?: (message: string) => void;
  err?: (message: string) => void;
}

export async function run(
  args: string[],
  deps: MakeSquashCommitDeps = {},
): Promise<number> {
  const out = deps.out ?? ((message: string): void => void process.stdout.write(message));
  const err = deps.err ?? ((message: string): void => void process.stderr.write(message));
  const readTreeMergeTarget = deps.readTreeMergeTarget ?? realReadTreeMergeTarget;
  const resolveRoot = deps.resolveRoot ?? ((projectDir: string) => repoRoot(projectDir));
  const build = deps.buildSquashPreview ?? buildSquashPreview;
  const writePreviewRecord =
    deps.writePreviewRecord ??
    ((name: string, record: SquashPreviewRecord, dataDir?: string) =>
      SQUASH_PREVIEW_DATA.write(name, record, dataDir));
  const now = deps.now ?? (() => new Date().toISOString());

  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (parseErr) {
    err(
      `make-squash-commit: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n${entranceRefusal("make-squash-commit entrance validation rejected the supplied arguments.")}${USAGE}`,
    );
    return 1;
  }

  if (parsed.name === undefined) {
    err(`make-squash-commit: missing <name>\n${entranceRefusal("make-squash-commit entrance validation requires a tree name.")}${USAGE}`);
    return 1;
  }
  const name = parsed.name;

  if (parsed.message === undefined || parsed.message.trim() === "") {
    err(
      `make-squash-commit: missing <commit message> — the message is a REQUIRED argument, ` +
        `never invented.\n${entranceRefusal("make-squash-commit entrance validation requires a commit message.")}Try:\n  ./bin/throne-cli make-squash-commit ${name} "<what this campaign delivered>"\n`,
    );
    return 1;
  }
  const message = parsed.message;

  const target = await readTreeMergeTarget(name, parsed.dataDir);
  if (target.repo === undefined || target.branch === undefined) {
    const missing = [
      ...(target.repo === undefined ? ["repo"] : []),
      ...(target.branch === undefined ? ["branch"] : []),
    ].join(" and ");
    err(
      `make-squash-commit: "${name}" has no usable recorded merge target ` +
        `(tree-base.json is absent, legacy, or lacks ${missing}) — refusing ` +
        `to guess a target. Repair data/${name}/tree-base.json (fields: repo, branch) and re-run. ` +
        "Nothing was previewed.\n",
    );
    return 1;
  }

  let root: string;
  try {
    root = await resolveRoot(target.repo);
  } catch (rootErr) {
    err(
      `make-squash-commit: cannot resolve repo root for "${target.repo}": ` +
        `${rootErr instanceof Error ? rootErr.message : String(rootErr)}\n`,
    );
    return 1;
  }

  let preview: SquashPreviewResult;
  try {
    preview = await build(root, name, target.branch, message);
  } catch (buildErr) {
    if (buildErr instanceof InternalsMessageError) {
      err(
        `make-squash-commit: ${buildErr.message}\n` +
          `Try:\n  ./bin/throne-cli make-squash-commit ${name} "<message with no throne-internals tokens>"\n`,
      );
      return 1;
    }
    err(
      `make-squash-commit: ${buildErr instanceof Error ? buildErr.message : String(buildErr)}\n`,
    );
    return 1;
  }

  await writePreviewRecord(
    name,
    {
      scratchRef: preview.scratchRef,
      squashCommit: preview.squashCommit,
      squashCase: preview.squashCase,
      candidateSha: preview.candidateSha,
      targetSha: preview.targetSha,
      targetBranch: target.branch,
      message,
      preSquashSha: preview.preSquashSha,
      builtAt: now(),
    },
    parsed.dataDir,
  );

  out(`SQUASH-CASE: ${preview.squashCase}\n`);
  out(
    `built squash preview for "${name}" on ${preview.scratchRef} as commit ${preview.squashCommit} ` +
      `(parented by "${target.branch}" @ ${preview.targetSha}); candidate untouched.\n`,
  );
  out(`pre-squash SHA (candidate tip, unchanged): ${preview.preSquashSha}\n`);
  if (preview.squashCase === "B") {
    out(
      "SQUASH-CASE B: this squash carries an UNREVIEWED merge resolution — the target moved and " +
        "was not a fast-forward. Tell the Regent to queue a follow-up Alpha to review the merge " +
        "resolution once this lands; that follow-up is REQUIRED, not advisory.\n",
    );
  }

  return 0;
}
