// Standalone, on-demand check for a foreign (non-delivery) commit already
// landed on a protected branch. Never wired into any tick or scheduler —
// invoked directly by a human/Alpha, and performs no automatic repair.
import {
  checkMainIntegrity,
  type MainIntegrityVerdict,
} from "../git-lifecycle/main-integrity.ts";
import { repoRoot } from "../git-lifecycle/git-command.service.ts";
import { THRONE_PROJECT_DIR } from "../git-lifecycle/git-worktree.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const USAGE =
  "Usage: ./bin/throne-cli check-main-integrity [repo-path] [branch]\n" +
  "  repo-path defaults to the live throne checkout; branch defaults to \"main\".\n";

interface Parsed {
  repoPath: string;
  branch: string;
}

export function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      throw new Error(`unknown flag "${arg}"`);
    }
    positional.push(arg);
  }
  if (positional.length > 2) {
    throw new Error(`unexpected argument "${positional[2]}"`);
  }
  return {
    repoPath: positional[0] ?? THRONE_PROJECT_DIR,
    branch: positional[1] ?? "main",
  };
}

/**
 * Injectable seams, mirroring `verify-delivery-runtime.ts`'s `VerifyDeliveryDeps`
 * shape. `repoRoot` defaults to the real git-lifecycle primitive so entrance
 * tests can prove refusals steer before any real git dependency runs, without
 * touching a real repo.
 */
export interface CheckMainIntegrityRuntimeDeps {
  out?: (message: string) => void;
  err?: (message: string) => void;
  dataDir?: string;
  repoRoot?: (projectDir: string) => Promise<string>;
}

function renderVerdict(verdict: MainIntegrityVerdict): string {
  switch (verdict.status) {
    case "no-baseline":
      return (
        `NO BASELINE: branch "${verdict.branch}" had no recorded known-good ` +
        `tip — recorded its current tip ${verdict.tip} as the new baseline.\n`
      );
    case "clean":
      return `CLEAN: branch "${verdict.branch}" at ${verdict.tip} is fully explained by recorded deliveries.\n`;
    case "foreign-commit-detected": {
      const lines = verdict.offending
        .map((commit) => `  ${commit.sha}  ${commit.subject}`)
        .join("\n");
      return (
        `FOREIGN COMMIT DETECTED on branch "${verdict.branch}": ${verdict.reason}\n` +
        `  known-good tip: ${verdict.knownGoodTip}\n` +
        `  current tip:    ${verdict.currentTip}\n` +
        `offending commit(s):\n${lines}\n` +
        "No repair was performed — the known-good marker was left unchanged " +
        "so this keeps flagging until a human/Alpha resolves it.\n"
      );
    }
  }
}

export async function run(
  args: string[],
  deps: CheckMainIntegrityRuntimeDeps = {},
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
      `check-main-integrity: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n${renderEntranceRefusal({ reason: "check-main-integrity entrance validation refused this invocation.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n${USAGE}`,
    );
    return 1;
  }

  const resolveRepoRoot = deps.repoRoot ?? repoRoot;
  let root: string;
  try {
    root = await resolveRepoRoot(parsed.repoPath);
  } catch (rootErr) {
    err(
      `check-main-integrity: "${parsed.repoPath}" does not resolve to a git repo: ${rootErr instanceof Error ? rootErr.message : String(rootErr)}\n`,
    );
    return 1;
  }

  let verdict: MainIntegrityVerdict;
  try {
    verdict = await checkMainIntegrity(root, parsed.branch, {
      dataDir: deps.dataDir,
    });
  } catch (checkErr) {
    err(
      `check-main-integrity: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}\n`,
    );
    return 1;
  }

  out(renderVerdict(verdict));
  return verdict.status === "foreign-commit-detected" ? 1 : 0;
}
