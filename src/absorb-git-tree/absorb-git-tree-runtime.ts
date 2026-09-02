// Performs the target-into-Alpha-branch absorb an `99a`/`99e`-shaped gate
// Shadow needs AND stamps the acting Shadow's own branch as a single call —
// replacing the manual `git merge` step the absorb ceremony currently uses,
// not a follow-up step someone must remember to run after it. Uses the
// shared Git lifecycle `absorbAndStamp`: merge the target's tip into the
// Alpha branch, then stamp the Shadow's own branch with a `Deliver <name>`
// commit over the just-landed tree, reusing the same commit-creation
// primitive `merge-git-tree`'s no-op stamp uses.
//
// The honest contract: there is no transaction spanning a merge and a later
// commit. The absorb lands first, the stamp follows; a stamp failure exits
// nonzero naming the exact half-state ("absorb landed, stamp missing") and
// changes nothing further. Re-running this command is safe and idempotent —
// it detects an already-landed absorb and an already-landed stamp
// independently, and completes only whichever is still missing, so history
// never gains a duplicate absorb commit.

import { absorbAndStamp } from "../git-lifecycle/absorb-and-stamp.ts";
import type { AbsorbAndStampResult } from "../git-lifecycle/absorb-and-stamp.ts";
import { THRONE_PROJECT_DIR } from "../git-lifecycle/git-worktree.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const USAGE =
  "Usage: ./bin/throne-cli absorb-git-tree [--project-dir <path>] <shadow-name> <target-branch> <alpha-branch>\n";

function entranceRefusal(reason: string): string {
  return `${renderEntranceRefusal({ reason, bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n`;
}

interface Parsed {
  projectDir?: string;
  shadowName?: string;
  targetBranch?: string;
  alphaBranch?: string;
}

/** Parse the three required positionals: the acting Shadow's own branch
 *  name, the recorded target branch to absorb (e.g. "main"), and the
 *  supervising Alpha's branch the absorb lands on. */
export function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--project-dir") {
      const projectDir = args[++i];
      if (projectDir === undefined || projectDir.startsWith("--")) {
        throw new Error('missing value for "--project-dir"');
      }
      parsed.projectDir = projectDir;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag "${arg}"`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 3) {
    throw new Error(`unexpected argument "${positionals[3]}"`);
  }
  [parsed.shadowName, parsed.targetBranch, parsed.alphaBranch] = positionals;
  return parsed;
}

export interface AbsorbGitTreeDeps {
  absorbAndStamp: (
    shadowName: string,
    projectDir: string,
    targetBranch: string,
    alphaBranch: string,
  ) => Promise<AbsorbAndStampResult>;
  out?: (message: string) => void;
  err?: (message: string) => void;
}

function describeOutcome(result: AbsorbAndStampResult): string {
  const absorbPart = result.absorbAlreadyLanded
    ? `absorb of "${result.alphaBranch}"'s target was already landed`
    : `absorbed target into "${result.alphaBranch}" as commit ${result.absorbCommit}`;
  const stampPart = result.stampAlreadyLanded
    ? `"${result.shadowBranch}" was already stamped`
    : `stamped "${result.shadowBranch}" as commit ${result.stampCommit}`;
  return `${absorbPart}; ${stampPart}\n`;
}

export async function run(
  args: string[],
  deps: AbsorbGitTreeDeps = { absorbAndStamp },
): Promise<number> {
  const out =
    deps.out ?? ((message: string): void => void process.stdout.write(message));
  const err =
    deps.err ?? ((message: string): void => void process.stderr.write(message));

  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (parseErr) {
    err(
      `absorb-git-tree: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n${entranceRefusal("absorb-git-tree entrance validation rejected the supplied arguments.")}${USAGE}`,
    );
    return 1;
  }

  const { shadowName, targetBranch, alphaBranch } = parsed;
  if (shadowName === undefined || targetBranch === undefined || alphaBranch === undefined) {
    err(`absorb-git-tree: missing <shadow-name> <target-branch> <alpha-branch>\n${entranceRefusal("absorb-git-tree entrance validation requires shadow, target, and Alpha branches.")}${USAGE}`);
    return 1;
  }

  try {
    const result = await deps.absorbAndStamp(
      shadowName,
      parsed.projectDir ?? THRONE_PROJECT_DIR,
      targetBranch,
      alphaBranch,
    );
    out(describeOutcome(result));
    return 0;
  } catch (absorbErr) {
    err(
      `absorb-git-tree: ${absorbErr instanceof Error ? absorbErr.message : String(absorbErr)}\n`,
    );
    return 1;
  }
}
