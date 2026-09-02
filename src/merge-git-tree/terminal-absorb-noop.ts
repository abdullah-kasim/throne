import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import {
  readAgentSupervisor,
  IdentityLineReadStatus,
} from "../agentdata/identity-data.service.ts";
import {
  contentTip,
  localBranchTip,
  readReachability,
  resolveLifecycleRepo,
} from "../git-lifecycle/branch-authority.ts";
import { readRevisionTreeIdentity } from "../git-lifecycle/path-wise-delivery.ts";
import { canonicalPath, runGit } from "../git-lifecycle/git-command.service.ts";
import { terminalGateRoleFromShadowName } from "./terminal-gate-shadow.ts";

export type TerminalAbsorbNoopDecision =
  | { readonly exempt: true }
  | { readonly exempt: false; readonly reason?: string };

async function requireRetained(
  root: string,
  retainedCommit: string,
  retainingCommit: string,
  failure: string,
): Promise<void> {
  const reachability = await readReachability(
    root,
    retainedCommit,
    retainingCommit,
  );
  if (reachability.code !== 0) throw new Error(failure);
}

async function requireAuthoritativeTargetAbsorb(
  root: string,
  contentCommit: string,
  alphaTip: string,
  campaignSpawnCommit: string,
  targetTip: string,
): Promise<void> {
  await requireRetained(
    root,
    campaignSpawnCommit,
    contentCommit,
    "the completion content is not on the supervising Alpha history after its recorded campaign spawn",
  );

  if (
    await isPostStampCanonicalAbsorb(root, contentCommit, alphaTip, targetTip)
  ) {
    return;
  }

  let current = contentCommit;
  for (;;) {
    if (current === campaignSpawnCommit) break;
    const fields = (
      await runGit(["rev-list", "--parents", "-n", "1", current], root)
    )
      .trim()
      .split(/\s+/);
    const parents = fields.slice(1);
    if (parents.length === 0) {
      throw new Error(
        "the supervising Alpha first-parent history ended before its recorded campaign spawn",
      );
    }
    if (parents.length > 2) {
      throw new Error(
        `campaign-history commit ${current} has ambiguous non-canonical absorb topology (${parents.length} parents)`,
      );
    }
    if (parents.length === 2) {
      const [campaignParent, absorbedTarget] = parents as [string, string];
      const [afterSpawn, targetMember] = await Promise.all([
        readReachability(root, campaignSpawnCommit, campaignParent),
        readReachability(root, absorbedTarget, targetTip),
      ]);
      if (afterSpawn.code === 0 && targetMember.code === 0) return;
    }
    current = parents[0]!;
  }

  throw new Error(
    "no canonical two-parent absorb on the bounded supervising Alpha first-parent campaign history has a second parent in recorded target history",
  );
}

async function isPostStampCanonicalAbsorb(
  root: string,
  contentCommit: string,
  alphaTip: string,
  targetTip: string,
): Promise<boolean> {
  const firstParentPath = (
    await runGit(
      [
        "rev-list",
        "--first-parent",
        "--reverse",
        "--ancestry-path",
        `${contentCommit}..${alphaTip}`,
      ],
      root,
    )
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const directChild = firstParentPath[0];
  if (directChild === undefined) return false;

  const parents = (
    await runGit(["rev-list", "--parents", "-n", "1", directChild], root)
  )
    .trim()
    .split(/\s+/)
    .slice(1);
  if (parents.length !== 2 || parents[0] !== contentCommit) return false;

  const [treeIdentity, targetMember] = await Promise.all([
    readRevisionTreeIdentity(root, directChild, contentCommit),
    readReachability(root, parents[1]!, targetTip),
  ]);
  return treeIdentity.equal && targetMember.code === 0;
}

export async function proveTerminalAbsorbNoopCompletion(
  name: string,
  dataDir?: string,
): Promise<TerminalAbsorbNoopDecision> {
  if (terminalGateRoleFromShadowName(name) !== "absorb") {
    return { exempt: false };
  }

  try {
    const [shadowRecord, supervisorRead] = await Promise.all([
      TREE_BASE_DATA.read(name, dataDir),
      readAgentSupervisor(name, dataDir),
    ]);
    // A field-absent supervisor and a read that never resolved both mean
    // "supervisor provenance cannot be confirmed" for this proof -- neither
    // may proceed to comparing it against the recorded merge target.
    if (
      shadowRecord?.repo === undefined ||
      supervisorRead.status !== IdentityLineReadStatus.Found
    ) {
      throw new Error(
        "durable Shadow tree or supervisor provenance is missing",
      );
    }
    const supervisor = supervisorRead.value;
    if (shadowRecord.branch !== supervisor) {
      throw new Error(
        `recorded merge target "${shadowRecord.branch}" is not supervising Alpha "${supervisor}"`,
      );
    }

    const alphaRecord = await TREE_BASE_DATA.read(supervisor, dataDir);
    if (alphaRecord?.repo === undefined || alphaRecord.branch === "") {
      throw new Error("durable supervising Alpha target provenance is missing");
    }
    const [shadowRepo, alphaRepo] = await Promise.all([
      canonicalPath(shadowRecord.repo),
      canonicalPath(alphaRecord.repo),
    ]);
    if (shadowRepo !== alphaRepo) {
      throw new Error(
        "Shadow and supervising Alpha records name different repositories",
      );
    }

    const root = await resolveLifecycleRepo(shadowRepo);
    const [shadowTip, alphaTip, targetTip] = await Promise.all([
      localBranchTip(root, name),
      localBranchTip(root, supervisor),
      localBranchTip(root, alphaRecord.branch),
    ]);
    if (
      shadowTip === undefined ||
      alphaTip === undefined ||
      targetTip === undefined
    ) {
      throw new Error("a recorded Shadow, Alpha, or target branch is missing");
    }
    if (shadowTip === shadowRecord.commit) {
      throw new Error(
        "the Shadow never advanced beyond its recorded spawn commit",
      );
    }

    const shadowContentTip = await contentTip(root, shadowTip);
    if (shadowContentTip === shadowTip) {
      throw new Error("the Shadow tip is not a content-empty completion stamp");
    }
    await requireRetained(
      root,
      shadowRecord.commit,
      shadowContentTip,
      "the completion content does not descend from the recorded Shadow spawn commit",
    );
    await requireRetained(
      root,
      shadowContentTip,
      alphaTip,
      "the supervising Alpha does not retain the Shadow's completion content",
    );
    await requireAuthoritativeTargetAbsorb(
      root,
      shadowContentTip,
      alphaTip,
      alphaRecord.commit,
      targetTip,
    );
    return { exempt: true };
  } catch (error) {
    return {
      exempt: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
