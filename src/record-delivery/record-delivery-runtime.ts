import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { localBranchTip } from "../git-lifecycle/branch-authority.ts";
import { readGitStatus, repoRoot } from "../git-lifecycle/git-command.service.ts";
import { isAncestor, writeDeliveryEvidence } from "../git-lifecycle/delivery.ts";

const USAGE =
  "Usage: throne record-delivery <agent-name> --commit <sha> [--data-dir <path>]\n";

interface Parsed {
  name?: string;
  commit?: string;
  dataDir?: string;
}

export function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--commit" || argument === "--data-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} needs a value`);
      }
      if (argument === "--commit") parsed.commit = value;
      else parsed.dataDir = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option "${argument}"`);
    } else if (parsed.name === undefined) {
      parsed.name = argument;
    } else {
      throw new Error(`unexpected argument "${argument}"`);
    }
  }
  return parsed;
}

export async function recordDelivery(
  name: string,
  commit: string,
  dataDir?: string,
): Promise<{ repo: string; targetBranch: string; commit: string }> {
  const treeBase = await TREE_BASE_DATA.read(name, dataDir);
  if (treeBase?.repo === undefined) {
    throw new Error(`"${name}" has no recorded target repository in its tree-base.json`);
  }
  const root = await repoRoot(treeBase.repo);
  const targetBranch = treeBase.branch;
  const targetTip = await localBranchTip(root, targetBranch);
  if (targetTip === undefined) {
    throw new Error(`recorded target branch "${targetBranch}" does not exist in ${root}`);
  }
  const resolved = await readGitStatus(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], root);
  if (resolved.code !== 0) {
    throw new Error(`"${commit}" is not a commit in ${root}`);
  }
  const fullCommit = resolved.stdout.trim();
  if (!(await isAncestor(root, fullCommit, targetTip))) {
    throw new Error(
      `commit ${fullCommit} is not reachable from "${name}"'s target branch "${targetBranch}" (tip ${targetTip}); nothing was recorded`,
    );
  }
  await writeDeliveryEvidence(name, root, targetBranch, fullCommit, dataDir);
  return { repo: root, targetBranch, commit: fullCommit };
}

export interface RecordDeliveryOutput {
  out?: (message: string) => void;
  err?: (message: string) => void;
}

export async function run(args: string[], output: RecordDeliveryOutput = {}): Promise<number> {
  const out = output.out ?? ((message: string): void => void process.stdout.write(message));
  const err = output.err ?? ((message: string): void => void process.stderr.write(message));
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (parseError) {
    err(`record-delivery: ${parseError instanceof Error ? parseError.message : String(parseError)}\n${USAGE}`);
    return 1;
  }
  if (parsed.name === undefined || parsed.commit === undefined) {
    err(`record-delivery: missing <agent-name> or --commit <sha>\n${USAGE}`);
    return 1;
  }
  try {
    const record = await recordDelivery(parsed.name, parsed.commit, parsed.dataDir);
    out(`recorded "${parsed.name}" as delivered at ${record.commit} on "${record.targetBranch}" in ${record.repo}\n`);
    return 0;
  } catch (recordError) {
    err(`record-delivery: ${recordError instanceof Error ? recordError.message : String(recordError)}\n`);
    return 1;
  }
}
