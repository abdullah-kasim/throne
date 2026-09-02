import path from "node:path";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import {
  writeIdentity,
  writeOpeningPrompt,
} from "../agentdata/identity-data.service.ts";
import {
  agentRegistrationExists,
  markAgentTasked,
  readSpawnSpec,
  writeSpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { LedgerDataService } from "../agentdata/ledger-data.service.ts";
import {
  ensureCodexTrust,
  probeCodexTrustPrompt,
} from "../codex-trust/codex-trust.service.ts";
import { closeAgentTab } from "../herdr/herdr-tab.service.ts";
import {
  reconcileIndeterminateAgentStart,
  resumeRegisteredAgentInRestoredTab,
} from "../herdr/herdr-create.service.ts";
import { startAgent } from "../herdr/herdr-creation-orchestration.ts";
import { openMessageQueueStore } from "../message-queue/message-queue.store.ts";
import { listAgents, resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { readUsageLogRaw } from "../plan-usage-remaining/telemetry-core/log.ts";
import {
  collectTokenBalanceReport,
  readUsageLogRowsOrEmpty,
} from "../token-balance/token-balance.command.ts";
import { isTokenBalanceEnabled } from "../steering-user-config.ts";
import type { CreateAgentDeps } from "./create.types.ts";
import { UsageReadersService } from "../shared-policy/usage-readers.service.ts";
import { realPlanUsageRemainingService } from "../plan-usage-remaining/plan-usage-remaining.service.ts";
import { resolveSpawnPolicy } from "./policy.ts";
import { resolveRegistration, removeRegistration } from "./registration.ts";
import { prepareCreateAgentRequest } from "./request.ts";
import { runResidentAgent } from "./resident-agent.ts";
import { writeQueueLaunchLinkage } from "./queue-launch-writeback.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { readUsageBypassAuthorizationRegistry } from "./usage-bypass-authorization.ts";
import { loadUserConfigFile } from "../user-config-loader.ts";
import { readModelBypassAuthorizationRegistry } from "./model-bypass-authorization.ts";
import { readStagerRouteAuthorizationRegistry } from "./stager-route-authorization.ts";
import { readModelAllowlist, writeModelAllowlist } from "./model-allowlist.ts";
import {
  managedWorktreeRoot,
  treeNameFromPath,
  worktreesHome,
} from "../git-lifecycle/git-worktree.service.ts";
import { repoRoot } from "../git-lifecycle/git-command.service.ts";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import type { TreeBase } from "../agentdata/tree-base-data.service.ts";
import { validateHydratedDependencies } from "../git-lifecycle/dependency-hydration.ts";

const REPO_ROOT = RUNTIME_THRONE_ROOT;
const REAL_USAGE_READERS = new UsageReadersService(
  undefined,
  undefined,
  realPlanUsageRemainingService(),
);
const REAL_LEDGER_DATA = new LedgerDataService();
const runGit = promisify(execFile);

const EMPTY_WORKSPACE_INSTRUCTIONS =
  "# Empty campaign workspace\n\n" +
  "This is a throne-managed empty scratch/staging workspace, not a target " +
  "Git checkout. It cannot serve as Git delivery authority. Any target " +
  "mutation or delivery must use the separately named target repository " +
  "worktree contract.\n";

/** Resolves the merged config's `identity` section into a usable git
 *  identity, or `undefined` when either field is missing/empty. Pure
 *  decision function — no I/O — so `prepareEmptyWorktree` can call it
 *  against whatever `loadUserConfigFile` handed back. */
export function resolveLocalWorkspaceIdentity(
  gitIdentity: Readonly<Record<string, unknown>> | undefined,
): { name: string; email: string } | undefined {
  const name = gitIdentity?.name;
  const email = gitIdentity?.email;
  if (typeof name !== "string" || name.trim() === "") return undefined;
  if (typeof email !== "string" || email.trim() === "") return undefined;
  return { name: name.trim(), email: email.trim() };
}

/** Reads the workspace's own LOCAL git identity (`git config --local`,
 *  never falling through to global/system config) so an already-configured
 *  resumed workspace is recognised and left untouched. */
async function readLocalWorkspaceIdentity(
  git: (...args: string[]) => Promise<{ stdout: string }>,
): Promise<{ name: string; email: string } | undefined> {
  try {
    const [{ stdout: name }, { stdout: email }] = await Promise.all([
      git("config", "--local", "--get", "user.name"),
      git("config", "--local", "--get", "user.email"),
    ]);
    if (name.trim() === "" || email.trim() === "") return undefined;
    return { name: name.trim(), email: email.trim() };
  } catch {
    return undefined;
  }
}

export async function prepareEmptyWorktree(
  name: string,
  cwd: string,
): Promise<string | undefined> {
  const expected = path.join(worktreesHome(), "empty", name);
  if (path.resolve(cwd) !== path.resolve(expected)) {
    return `--empty-worktree requires its managed workspace path "${expected}"`;
  }
  let existed = true;
  try {
    try {
      await stat(cwd);
    } catch {
      existed = false;
    }
    await mkdir(cwd, { recursive: true });
    const entries = await readdir(cwd);
    const instructions = path.join(cwd, "AGENTS.md");
    const hasGit = entries.includes(".git");
    if (existed && !hasGit) {
      return `managed empty workspace "${cwd}" already exists without its managed Git repository`;
    }
    if (entries.some((entry) => entry !== "AGENTS.md" && entry !== ".git")) {
      return `managed empty workspace "${cwd}" is not empty`;
    }
    if (hasGit && !(await stat(path.join(cwd, ".git"))).isDirectory()) {
      return `managed empty workspace "${cwd}" has a non-directory .git entry`;
    }
    if (entries.includes("AGENTS.md")) {
      const current = await readFile(instructions, "utf8");
      if (current !== EMPTY_WORKSPACE_INSTRUCTIONS) {
        return `managed empty workspace "${cwd}" has conflicting AGENTS.md`;
      }
    } else {
      await writeFile(instructions, EMPTY_WORKSPACE_INSTRUCTIONS, "utf8");
    }
    const git = async (...args: string[]) => runGit("git", args, { cwd });
    if (!hasGit) await git("init", "--quiet");
    let identity = await readLocalWorkspaceIdentity(git);
    if (identity === undefined) {
      const userConfig = await loadUserConfigFile();
      identity = resolveLocalWorkspaceIdentity(userConfig?.identity);
      if (identity === undefined) {
        if (!existed)
          await rm(cwd, { recursive: true, force: true }).catch(
            () => undefined,
          );
        return "git identity could not be resolved — set `identity.name`/`identity.email` in config.user.ts";
      }
      await git("config", "user.name", identity.name);
      await git("config", "user.email", identity.email);
    }
    await git("remote", "remove", "origin").catch(() => undefined);
    await git("add", "AGENTS.md");
    const head = await git("rev-parse", "--verify", "HEAD")
      .then(() => true)
      .catch(() => false);
    if (!head)
      await git(
        "commit",
        "--quiet",
        "-m",
        "Initialize empty campaign workspace",
      );
    const remotes = await git("remote");
    if (remotes.stdout.trim() !== "")
      return `managed empty workspace "${cwd}" has a remote`;
    const status = await git("status", "--porcelain");
    if (status.stdout.trim() !== "")
      return `managed empty workspace "${cwd}" is not clean`;
    const author = await git("show", "-s", "--format=%an <%ae>", "HEAD");
    if (author.stdout.trim() !== `${identity.name} <${identity.email}>`) {
      return `managed empty workspace "${cwd}" has unexpected initial commit author`;
    }
    return undefined;
  } catch (error) {
    if (!existed)
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    return `managed empty workspace "${cwd}" could not be prepared: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function verifyEmptyWorktree(
  name: string,
  cwd: string,
): Promise<string | undefined> {
  const expected = path.join(worktreesHome(), "empty", name);
  if (path.resolve(cwd) !== path.resolve(expected))
    return `empty workspace path does not match durable name`;
  try {
    const git = async (...args: string[]) => runGit("git", args, { cwd });
    let gitEntry;
    try {
      gitEntry = await stat(path.join(cwd, ".git"));
    } catch {
      return "empty workspace has no repository-local .git directory";
    }
    if (!gitEntry.isDirectory()) {
      return "empty workspace has no repository-local .git directory";
    }
    const marker = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    if (marker !== EMPTY_WORKSPACE_INSTRUCTIONS)
      return "empty workspace AGENTS.md contract changed";
    await git("rev-parse", "--verify", "HEAD");
    if ((await git("remote")).stdout.trim() !== "")
      return "empty workspace has a remote";
    if ((await git("status", "--porcelain")).stdout.trim() !== "")
      return "empty workspace is not clean";
    return undefined;
  } catch (error) {
    return `empty workspace resume contract is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function validateAlphaTree(
  name: string,
  cwd: string,
  readTree: (
    agentName: string,
  ) => Promise<TreeBase | null> = TREE_BASE_DATA.read.bind(TREE_BASE_DATA),
  role = "Alpha",
): Promise<string | undefined> {
  if (treeNameFromPath(cwd) !== name) {
    return `campaign ${role} "${name}" must launch from its matching external worktree`;
  }
  const tree = await readTree(name);
  if (tree === null) {
    return `campaign ${role} "${name}" has no tree-base.json; prepare its external worktree before registration`;
  }
  if (tree.name !== name) {
    return `campaign ${role} "${name}" has tree-base.json for "${tree.name}"`;
  }
  if (typeof tree.repo !== "string" || tree.repo === "") {
    return `campaign ${role} "${name}" has tree-base.json without target-repository provenance`;
  }
  try {
    const [preparedWorktree, cwdRepo] = await Promise.all([
      repoRoot(tree.repo).then((root) =>
        realpath(managedWorktreeRoot(root, name)),
      ),
      repoRoot(cwd).then((root) => realpath(root)),
    ]);
    if (cwdRepo !== preparedWorktree) {
      return `campaign ${role} "${name}" cwd is not inside its recorded prepared worktree`;
    }
    await validateHydratedDependencies(cwd);
  } catch (error) {
    return `campaign ${role} "${name}" target-repository provenance is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

export async function validateShadowTree(
  name: string,
  cwd: string,
  readTree: Parameters<typeof validateAlphaTree>[2] = TREE_BASE_DATA.read.bind(
    TREE_BASE_DATA,
  ),
): Promise<string | undefined> {
  return validateAlphaTree(name, cwd, readTree, "Shadow");
}

const REAL_DEPS: CreateAgentDeps = {
  resolveAgent,
  startAgent,
  openMessageQueueStore: () => openMessageQueueStore(),
  resumeRegisteredAgentInRestoredTab,
  closeAgentTab,
  ensureCodexTrust,
  probeCodexTrustPrompt,
  writeIdentity,
  writeOpeningPrompt,
  writeSpawnSpec,
  writeModelAllowlist,
  readSpawnSpec,
  markAgentTasked,
  registrationExists: agentRegistrationExists,
  removeRegistration,
  getClaudeUsage: REAL_USAGE_READERS.claude,
  getCodexUsage: REAL_USAGE_READERS.codex,
  getOpenCodeGoUsage: REAL_USAGE_READERS.opencodeGo,
  readUsageLogRaw,
  readUsageBypassAuthorizations: readUsageBypassAuthorizationRegistry,
  readModelBypassAuthorizations: readModelBypassAuthorizationRegistry,
  readStagerRouteAuthorizations: readStagerRouteAuthorizationRegistry,
  readModelAllowlist,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date().toISOString(),
  afterRegistration: async () => {},
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  validateAlphaTree,
  validateShadowTree,
  writeQueueLaunchLinkage,
  resolveTokenBalanceVerdict: () =>
    collectTokenBalanceReport(readUsageLogRowsOrEmpty()).verdict,
  isTokenBalanceOperatorEnabled: isTokenBalanceEnabled,
};

export async function runCreateAgent(
  args: string[],
  dependencies: CreateAgentDeps,
): Promise<number> {
  const request = await prepareCreateAgentRequest(
    args,
    dependencies,
    REPO_ROOT,
  );
  if (!request.ok) return request.code;
  const registration = await resolveRegistration(request.value, dependencies);
  if (!registration.ok) return registration.code;
  if (registration.value.resuming && registration.value.emptyWorktree) {
    const refusal = await verifyEmptyWorktree(
      registration.value.name,
      registration.value.cwd,
    );
    if (refusal !== undefined) {
      dependencies.writeStderr?.(
        `create-agent: refusing exact empty-workspace resume — ${refusal}. Nothing was registered or launched.\n`,
      );
      return 1;
    }
  }
  if (
    !registration.value.resuming &&
    request.value.flags["non-campaign"] !== true &&
    (registration.value.role.trim().toLowerCase() === "alpha" ||
      registration.value.role.trim().toLowerCase() === "shadow") &&
    !registration.value.emptyWorktree &&
    (registration.value.role.trim().toLowerCase() === "alpha"
      ? dependencies.validateAlphaTree
      : (dependencies.validateShadowTree ?? validateShadowTree)) !== undefined
  ) {
    const validateTree =
      registration.value.role.trim().toLowerCase() === "alpha"
        ? dependencies.validateAlphaTree
        : (dependencies.validateShadowTree ?? validateShadowTree);
    const refusal = await validateTree!(
      registration.value.name,
      registration.value.requestedCwd,
    );
    if (refusal !== undefined) {
      dependencies.writeStderr?.(
        `create-agent: refusing campaign Alpha launch — ${refusal}. Nothing was registered or launched.\n`,
      );
      return 1;
    }
  }
  const policy = await resolveSpawnPolicy(registration.value, dependencies);
  if (!policy.ok) return policy.code;
  if (policy.value.emptyWorktree) {
    const refusal = await prepareEmptyWorktree(
      policy.value.name,
      policy.value.requestedCwd,
    );
    if (refusal !== undefined) {
      dependencies.writeStderr?.(
        `create-agent: refusing ${refusal}. Nothing was registered or launched.\n`,
      );
      return 1;
    }
  }
  const launchCode = policy.value.oneShot
    ? await dependencies.customHarnessService!.run(policy.value, dependencies)
    : await runResidentAgent(policy.value, dependencies);
  if (launchCode === 0) {
    await (dependencies.writeQueueLaunchLinkage ?? writeQueueLaunchLinkage)(
      policy.value.name,
      policy.value.objectiveContract,
    );
  }
  return launchCode;
}

export async function run(
  args: string[],
  dependencies: CreateAgentDeps = REAL_DEPS,
  customHarnessService?: CreateAgentDeps["customHarnessService"],
): Promise<number> {
  if (dependencies !== REAL_DEPS) return runCreateAgent(args, dependencies);
  let liveAgents;
  try {
    liveAgents = await listAgents();
  } catch (error) {
    process.stderr.write(
      `create-agent: cannot resolve the authoritative live throne ledger: ${error instanceof Error ? error.message : String(error)}.\n`,
    );
    return 1;
  }
  const ledger = await REAL_LEDGER_DATA.resolveLiveLedger({
    invocationCwd: process.cwd(),
    liveAgents,
    sameAgentName,
  });
  if (!ledger.ok) {
    process.stderr.write(`create-agent: ${ledger.reason}.\n`);
    return 1;
  }
  const dataDir = ledger.dataDir;
  return runCreateAgent(args, {
    ...dependencies,
    customHarnessService,
    writeIdentity: (name, identity) => writeIdentity(name, identity, dataDir),
    writeOpeningPrompt: (name, text) => writeOpeningPrompt(name, text, dataDir),
    writeSpawnSpec: (name, spec) => writeSpawnSpec(name, spec, dataDir),
    writeModelAllowlist: (options) =>
      writeModelAllowlist({ ...options, dataDir }),
    readSpawnSpec: (name) => readSpawnSpec(name, dataDir),
    registrationExists: (name) => agentRegistrationExists(name, dataDir),
    removeRegistration: (name) => removeRegistration(name, dataDir),
    readUsageBypassAuthorizations: () =>
      readUsageBypassAuthorizationRegistry(dataDir),
    readModelBypassAuthorizations: () =>
      readModelBypassAuthorizationRegistry(dataDir),
    readStagerRouteAuthorizations: () =>
      readStagerRouteAuthorizationRegistry(dataDir),
    readModelAllowlist: (ownerAlphaName) =>
      readModelAllowlist(ownerAlphaName, dataDir),
  });
}
