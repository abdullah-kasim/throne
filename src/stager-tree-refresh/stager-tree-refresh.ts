import path from "node:path";
import {
  IdentityLineReadStatus,
  readAgentRole,
} from "../agentdata/identity-data.service.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  CHECKOUT_STANDING,
  checkoutStandingAgainst,
  fastForwardCheckoutOnto,
  type CheckoutStanding,
} from "../git-lifecycle/checkout-standing.ts";
import {
  GitLifecycleService,
  canonicalPath,
  runGit,
} from "../git-lifecycle/git-command.service.ts";
import { MODEL_ROLES } from "../harness-routing/model-registry.ts";

export const TAB_AGENT_NAME_VARIABLE = "THRONE_AGENT_NAME";

const MAIN_BRANCH = "refs/heads/main";

export interface StagerTreeRefreshRequest {
  readonly agentName: string | undefined;
  readonly agentLedgerDirectory: string;
  readonly promptDirectory: string;
}

export async function isRegisteredStager(
  agentName: string,
  agentLedgerDirectory: string,
): Promise<boolean> {
  const role = await readAgentRole(agentName, agentLedgerDirectory);
  return role.status === IdentityLineReadStatus.Found && role.value === MODEL_ROLES.STAGER;
}

async function isInsideTree(directory: string, tree: string): Promise<boolean> {
  const [canonicalDirectory, canonicalTree] = await Promise.all([
    canonicalPath(directory),
    canonicalPath(tree),
  ]);
  const relative = path.relative(canonicalTree, canonicalDirectory);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function stagerTreeOfPromptSession(
  request: StagerTreeRefreshRequest,
): Promise<string | undefined> {
  const { agentName, agentLedgerDirectory, promptDirectory } = request;
  if (agentName === undefined || agentName === "") return undefined;
  if (!(await isRegisteredStager(agentName, agentLedgerDirectory))) return undefined;
  const tree = (await readSpawnSpec(agentName, agentLedgerDirectory))?.cwd;
  if (tree === undefined) return undefined;
  return (await isInsideTree(promptDirectory, tree)) ? tree : undefined;
}

function commitsCount(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

async function lineForStanding(
  tree: string,
  standing: CheckoutStanding,
): Promise<string | undefined> {
  const behind = commitsCount(standing.commitsBehind);
  switch (standing.kind) {
    case CHECKOUT_STANDING.UP_TO_DATE:
      return undefined;
    case CHECKOUT_STANDING.BEHIND:
      return `Fast-forwarded this Stager checkout ${behind} to main (${await runGit(["rev-parse", "--short", "HEAD"], tree)}), so its skills and docs are current.`;
    case CHECKOUT_STANDING.DIRTY:
      return `WARNING: this Stager checkout is ${behind} behind main and was NOT updated, because it has uncommitted changes. Its skills and docs are stale until it is clean and fast-forwarded with git merge --ff-only main.`;
    case CHECKOUT_STANDING.DIVERGED:
      return `WARNING: this Stager checkout is ${behind} behind main and ${commitsCount(standing.commitsAhead)} ahead of it, so it was NOT fast-forwarded. Its skills and docs are stale; read the current text with git show main:<path>.`;
  }
}

export async function fastForwardTreeToMainWhenOnlyBehind(
  tree: string,
  git: GitLifecycleService = new GitLifecycleService(),
): Promise<CheckoutStanding> {
  const standing = await checkoutStandingAgainst(tree, MAIN_BRANCH, git);
  if (standing.kind === CHECKOUT_STANDING.BEHIND) {
    await fastForwardCheckoutOnto(tree, MAIN_BRANCH, git);
  }
  return standing;
}

export async function refreshStagerTreeForPrompt(
  request: StagerTreeRefreshRequest,
): Promise<string | undefined> {
  const tree = await stagerTreeOfPromptSession(request);
  if (tree === undefined) return undefined;
  return lineForStanding(tree, await fastForwardTreeToMainWhenOnlyBehind(tree));
}
