import { readFile } from "node:fs/promises";
import path from "node:path";
import { PERSONA_CONFIG } from "../application-config.service.ts";
import { readLiveClaudeModel } from "../session/live-claude-model.ts";
import { readAccountsConfig } from "../account/accounts-config.ts";
import { claudeProjectsFolderOf, type ReadAccountsConfig } from "../account/agent-account.ts";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import {
  readSpawnSpec,
  writeSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import {
  sameAgentName,
  type HerdrAgent,
} from "../herdr/herdr-identity-contracts.ts";
import {
  harnessProvenance,
  type HarnessProvenance,
} from "../herdr/harness-provenance.ts";
import type { HerdrPaneProcessInfo } from "../herdr/herdr-inventory.service.ts";
import { hasAgentName } from "../herdr/herdr-agent-name.ts";
import {
  isLiveHarnessProcess,
  paneHasLiveHarnessProcess,
} from "../herdr/herdr-process-detection.ts";
import {
  getPaneProcessInfo,
  listAgents,
  renameAgent,
} from "../herdr/herdr-runtime.service.ts";
import { sleep } from "../herdr/herdr-screen.service.ts";
import { currentPaneId } from "../herdr/herdr-session.service.ts";
import {
  REGENT_DIR,
  REGENT_NAME,
  acquireResurrectLock,
  releaseResurrectLock,
} from "../regent-state/regent-state.service.ts";
import { errorText } from "../shared-policy/error-text.ts";
import {
  IdentityLineReadStatus,
  readAgentRole,
  readAgentSupervisor,
} from "../agentdata/identity-data.service.ts";
import { resolveTargetEffort, targetEffortForAgent } from "../config.ts";
import { parseHarness } from "../harness-routing/model-registry.ts";
import { modelEffortRange } from "../harness-routing/policy/capabilities.ts";
import {
  REAL_RESUME_CONTRACT,
  resumeOrphan,
} from "../throne-startup/throne-startup-reconciliation.service.ts";
import {
  classifyRestartVerdict,
  isRegent,
  regentSkippedForHeldLock,
  relaunchAgent,
} from "./restart-harnesses-relaunch.ts";

export const GRACEFUL_STOP_TIMEOUT_MS = 30_000;
export const FORCED_STOP_TIMEOUT_MS = 10_000;
export const STOP_POLL_MS = 250;

export interface RestartHarnessesDeps {
  listAgents: () => Promise<HerdrAgent[]>;
  currentPaneId: () => Promise<string | undefined>;
  getPaneProcessInfo: (paneId: string) => Promise<HerdrPaneProcessInfo>;
  signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  writeSpawnSpec: (name: string, spec: SpawnSpec) => Promise<void>;
  readLiveModel: (agent: HerdrAgent, recordedAccount: string | undefined) => Promise<string | undefined>;
  readHarnessRecord: (name: string) => Promise<string | undefined>;
  resume: (name: string) => Promise<void>;
  harnessProvenance: (paneId: string) => Promise<HarnessProvenance>;
  readAccountsConfig: ReadAccountsConfig;
  configuredEffort: (
    name: string,
    role: string | undefined,
    spec: SpawnSpec,
  ) => Promise<number | undefined>;
  renameAgent: (paneId: string, name: string) => Promise<void>;
  acquireRegentRestartLock: () => Promise<string | null>;
  releaseRegentRestartLock: (token: string) => Promise<void>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

export interface RestartHarnessesOptions {
  dryRun: boolean;
  force: boolean;
  only: string[];
}

export type RestartVerdict = "restarted" | "skipped" | "failed";

export interface RestartOutcome {
  name: string;
  verdict: RestartVerdict;
  detail: string;
}

export function buildHarnessRestartPrompt(name: string, harness: string): string {
  return (
    `You are \`${name}\`. The court restarted your ${harness} harness process onto the newly pinned binary ` +
    "(`throne restart-harnesses`) and relaunched you into your EXACT previous native session, so the transcript above is your own. " +
    "Nothing was lost: re-read your last turn and CONTINUE where it stopped — do not restart the work and do not re-plan what you already finished. " +
    `Report progress to your supervisor and escalate genuine blockers to the ${PERSONA_CONFIG.tierTitles.regent} via send-agent.`
  );
}

async function currentPaneIdOrUndefined(): Promise<string | undefined> {
  try {
    return await currentPaneId();
  } catch {
    return undefined;
  }
}

async function readHarnessRecordFromLedger(name: string): Promise<string | undefined> {
  try {
    return (await readFile(path.join(THRONE_DATA_DIR, name, "harness"), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

export const REAL_DEPS: RestartHarnessesDeps = {
  listAgents: () => listAgents(),
  currentPaneId: currentPaneIdOrUndefined,
  getPaneProcessInfo,
  signalProcess: (pid, signal) => process.kill(pid, signal),
  sleep,
  now: Date.now,
  readSpawnSpec: (name) => readSpawnSpec(name),
  writeSpawnSpec: (name, spec) => writeSpawnSpec(name, spec),
  readLiveModel: (agent, recordedAccount) =>
    readLiveClaudeModel(agent, claudeProjectsFolderOf(recordedAccount)),
  readHarnessRecord: readHarnessRecordFromLedger,
  resume: (name) =>
    resumeOrphan(name, {
      ...REAL_RESUME_CONTRACT,
      exactResumePrompt: buildHarnessRestartPrompt,
    }),
  harnessProvenance: (paneId) => harnessProvenance(paneId),
  readAccountsConfig,
  configuredEffort: readConfiguredEffort,
  renameAgent: (paneId, name) => renameAgent(paneId, name),
  acquireRegentRestartLock: () => acquireResurrectLock(REGENT_DIR),
  releaseRegentRestartLock: (token) => releaseResurrectLock(REGENT_DIR, token),
  log: (message) => process.stdout.write(message),
  warn: (message) => process.stderr.write(message),
};

async function campaignEffortOfSupervisor(name: string): Promise<number | undefined> {
  const supervisor = await readAgentSupervisor(name);
  if (supervisor.status !== IdentityLineReadStatus.Found) return undefined;
  const supervisorSpec = await readSpawnSpec(supervisor.value).catch(() => null);
  return supervisorSpec?.campaign_effort;
}

export async function readConfiguredEffort(
  name: string,
  role: string | undefined,
  spec: SpawnSpec,
): Promise<number | undefined> {
  if (role === undefined) {
    const identityRole = await readAgentRole(name);
    if (identityRole.status !== IdentityLineReadStatus.Found) return undefined;
    role = identityRole.value;
  }
  const campaignEffort = spec.campaign_effort ?? await campaignEffortOfSupervisor(name);
  if (campaignEffort !== undefined) return undefined;
  let range;
  try {
    range = modelEffortRange(parseHarness(spec.harness), spec.model);
  } catch {
    return undefined;
  }
  if (range === undefined) return undefined;
  return resolveTargetEffort(
    targetEffortForAgent(role, name, spec.objective_code),
    range,
  );
}

export class RestartHarnessesUsageError extends Error {
  readonly name = "RestartHarnessesUsageError";
}

export function parseRestartHarnessesArguments(
  args: readonly string[],
): RestartHarnessesOptions {
  const options: RestartHarnessesOptions = { dryRun: false, force: false, only: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--only") {
      const name = args[index + 1];
      if (name === undefined || name.startsWith("--")) {
        throw new RestartHarnessesUsageError("--only requires an agent name");
      }
      options.only.push(name);
      index += 1;
    } else {
      throw new RestartHarnessesUsageError(
        `unknown argument "${arg}"; usage: restart-harnesses [--dry-run] [--force] [--only <name>]...`,
      );
    }
  }
  return options;
}

function restartOrderRank(agent: HerdrAgent, invokingPaneId: string | undefined): number {
  if (agent.paneId === invokingPaneId) return 2;
  if (isRegent(agent)) return 1;
  return 0;
}

function selectedByOnly(agent: HerdrAgent, only: readonly string[]): boolean {
  return (
    only.length === 0 ||
    (agent.name !== undefined && only.some((name) => sameAgentName(name, agent.name!)))
  );
}

export function planRestarts(
  agents: readonly HerdrAgent[],
  invokingPaneId: string | undefined,
  options: RestartHarnessesOptions,
): { targets: HerdrAgent[]; skipped: RestartOutcome[] } {
  const targets: HerdrAgent[] = [];
  const skipped: RestartOutcome[] = [];
  for (const agent of agents) {
    if (!hasAgentName(agent)) {
      skipped.push({ name: `(${agent.agent}) ${agent.paneId}`, verdict: "skipped", detail: "unnamed pane" });
      continue;
    }
    if (!selectedByOnly(agent, options.only)) continue;
    if (agent.agentStatus === "working" && !options.force && agent.paneId !== invokingPaneId) {
      skipped.push({ name: agent.name, verdict: "skipped", detail: "status is working; pass --force to restart it anyway" });
      continue;
    }
    targets.push(agent);
  }
  targets.sort((left, right) => restartOrderRank(left, invokingPaneId) - restartOrderRank(right, invokingPaneId));
  return { targets, skipped };
}

function harnessProcessIds(processInfo: HerdrPaneProcessInfo): number[] {
  return processInfo.foregroundProcesses
    .filter(isLiveHarnessProcess)
    .map((process) => process.pid)
    .filter((pid): pid is number => typeof pid === "number");
}

async function waitForPaneWithoutHarness(
  paneId: string,
  timeoutMilliseconds: number,
  deps: RestartHarnessesDeps,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMilliseconds;
  for (;;) {
    if (!paneHasLiveHarnessProcess(await deps.getPaneProcessInfo(paneId))) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(STOP_POLL_MS);
  }
}

export async function stopHarnessInPane(
  paneId: string,
  deps: RestartHarnessesDeps,
): Promise<void> {
  const pids = harnessProcessIds(await deps.getPaneProcessInfo(paneId));
  if (pids.length === 0) {
    throw new Error(`pane "${paneId}" has no live harness process to stop`);
  }
  for (const pid of pids) deps.signalProcess(pid, "SIGTERM");
  if (await waitForPaneWithoutHarness(paneId, GRACEFUL_STOP_TIMEOUT_MS, deps)) return;
  for (const pid of pids) deps.signalProcess(pid, "SIGKILL");
  if (await waitForPaneWithoutHarness(paneId, FORCED_STOP_TIMEOUT_MS, deps)) return;
  throw new Error(`harness in pane "${paneId}" survived SIGTERM and SIGKILL`);
}

function restartAgentInPlace(
  agent: HerdrAgent,
  deps: RestartHarnessesDeps,
): Promise<RestartOutcome> {
  return relaunchAgent(agent, deps, () => stopHarnessInPane(agent.paneId, deps));
}

async function restartRegentUnderLock(
  agent: HerdrAgent,
  deps: RestartHarnessesDeps,
): Promise<RestartOutcome> {
  const token = await deps.acquireRegentRestartLock();
  if (token === null) {
    return regentSkippedForHeldLock(agent);
  }
  try {
    return await restartAgentInPlace(agent, deps);
  } finally {
    await deps.releaseRegentRestartLock(token);
  }
}

async function restartOne(agent: HerdrAgent, deps: RestartHarnessesDeps): Promise<RestartOutcome> {
  try {
    return isRegent(agent)
      ? await restartRegentUnderLock(agent, deps)
      : await restartAgentInPlace(agent, deps);
  } catch (error) {
    return { name: agent.name!, verdict: "failed", detail: errorText(error) };
  }
}

function renderOutcome(outcome: RestartOutcome): string {
  return `restart-harnesses: ${outcome.verdict.padEnd(9)} ${outcome.name} — ${outcome.detail}\n`;
}

function beforeSelfStopMessage(agent: HerdrAgent): string {
  return `restart-harnesses: stopping the invoking harness's own pane (${agent.paneId}) to restart it — this is the last target\n`;
}

function accountsConfigProblem(readConfig: ReadAccountsConfig): string | undefined {
  try {
    readConfig();
    return undefined;
  } catch (error) {
    return errorText(error);
  }
}

export async function restartHarnesses(
  options: RestartHarnessesOptions,
  deps: RestartHarnessesDeps,
): Promise<RestartOutcome[]> {
  const invokingPaneId = await deps.currentPaneId();
  const { targets, skipped } = planRestarts(await deps.listAgents(), invokingPaneId, options);
  for (const outcome of skipped) deps.warn(renderOutcome(outcome));
  if (options.dryRun) {
    for (const agent of targets) {
      const spec = await deps.readSpawnSpec(agent.name!);
      const classification = classifyRestartVerdict(agent, spec);
      const detail =
        classification.verdict === "restarted"
          ? `would stop pane ${agent.paneId} and resume session ${agent.sessionId} (dry run)${spec === null ? "; a spawn record would be created first" : ""}`
          : classification.detail;
      const outcome: RestartOutcome = { name: agent.name!, verdict: classification.verdict, detail };
      (outcome.verdict === "failed" ? deps.warn : deps.log)(renderOutcome(outcome));
    }
    return skipped;
  }
  const outcomes: RestartOutcome[] = [...skipped];
  const accountsProblem = accountsConfigProblem(deps.readAccountsConfig);
  if (accountsProblem !== undefined) {
    for (const agent of targets) {
      const outcome: RestartOutcome = { name: agent.name!, verdict: "failed", detail: `${accountsProblem}; nothing was stopped` };
      deps.warn(renderOutcome(outcome));
      outcomes.push(outcome);
    }
    return outcomes;
  }
  for (const agent of targets) {
    if (agent.paneId === invokingPaneId) deps.log(beforeSelfStopMessage(agent));
    const outcome = await restartOne(agent, deps);
    (outcome.verdict === "failed" ? deps.warn : deps.log)(renderOutcome(outcome));
    outcomes.push(outcome);
  }
  return outcomes;
}
