import { readFile } from "node:fs/promises";
import path from "node:path";
import { PERSONA_CONFIG } from "../application-config.service.ts";
import { readLiveClaudeModel } from "../session/live-claude-model.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import {
  readSpawnSpec,
  writeSpawnSpec,
  type SpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import {
  sameAgentName,
  type HerdrAgent,
} from "../herdr/herdr-identity-contracts.ts";
import type { HerdrPaneProcessInfo } from "../herdr/herdr-inventory.service.ts";
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
  REAL_RESUME_CONTRACT,
  resumeOrphan,
} from "../throne-startup/throne-startup-reconciliation.service.ts";

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
  readLiveModel: (agent: HerdrAgent) => Promise<string | undefined>;
  readHarnessRecord: (name: string) => Promise<string | undefined>;
  resume: (name: string) => Promise<void>;
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
    return (await readFile(path.join(RUNTIME_DATA_DIR, name, "harness"), "utf8")).trim() || undefined;
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
  readLiveModel: readLiveClaudeModel,
  readHarnessRecord: readHarnessRecordFromLedger,
  resume: (name) =>
    resumeOrphan(name, {
      ...REAL_RESUME_CONTRACT,
      exactResumePrompt: buildHarnessRestartPrompt,
    }),
  renameAgent: (paneId, name) => renameAgent(paneId, name),
  acquireRegentRestartLock: () => acquireResurrectLock(REGENT_DIR),
  releaseRegentRestartLock: (token) => releaseResurrectLock(REGENT_DIR, token),
  log: (message) => process.stdout.write(message),
  warn: (message) => process.stderr.write(message),
};

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

function isRegent(agent: HerdrAgent): boolean {
  return agent.name !== undefined && sameAgentName(agent.name, REGENT_NAME);
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
    if (agent.name === undefined) {
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

async function recordLiveSessionAndModel(
  name: string,
  spec: SpawnSpec,
  sessionId: string,
  liveModel: string | undefined,
  deps: RestartHarnessesDeps,
): Promise<void> {
  const sessionChanged = spec.session_id?.toLowerCase() !== sessionId.toLowerCase();
  const modelChanged = liveModel !== undefined && liveModel !== spec.model;
  if (!sessionChanged && !modelChanged) return;
  const modelFields = modelChanged
    ? { model: liveModel, switched_at: new Date(deps.now()).toISOString() }
    : {};
  await deps.writeSpawnSpec(name, { ...spec, ...modelFields, session_id: sessionId });
}

export async function ensurePaneCarriesName(
  agent: HerdrAgent,
  name: string,
  deps: RestartHarnessesDeps,
): Promise<void> {
  const inTab = (await deps.listAgents()).filter((candidate) => candidate.tabId === agent.tabId);
  if (inTab.some((candidate) => candidate.name !== undefined && sameAgentName(candidate.name, name))) return;
  if (inTab.length !== 1) {
    throw new Error(`after the relaunch, tab "${agent.tabId}" holds ${inTab.length} agents and none is named "${name}"`);
  }
  await deps.renameAgent(inTab[0]!.paneId, name);
}

const NO_SESSION_ID_DETAIL = "herdr reports no native session id, so an exact resume is impossible";
const SYNTHESIS_DETAIL = "a spawn record will be synthesized from herdr and the live transcript";

function classifyRestartVerdict(
  agent: HerdrAgent,
  spec: SpawnSpec | null,
): { verdict: RestartVerdict; detail: string } {
  if (agent.sessionId === undefined) {
    return { verdict: "failed", detail: NO_SESSION_ID_DETAIL };
  }
  return spec === null
    ? { verdict: "restarted", detail: SYNTHESIS_DETAIL }
    : { verdict: "restarted", detail: `resumed native session ${agent.sessionId}` };
}

async function synthesizeSpawnSpec(
  agent: HerdrAgent,
  liveModel: string | undefined,
  deps: RestartHarnessesDeps,
): Promise<SpawnSpec> {
  const harness = (await deps.readHarnessRecord(agent.name!)) ?? agent.agent;
  return {
    harness,
    model: liveModel ?? "unknown",
    effort: 1,
    cwd: agent.cwd,
    session_id: agent.sessionId,
    spawned_at: new Date(deps.now()).toISOString(),
  };
}

async function restartAgentInPlace(
  agent: HerdrAgent,
  deps: RestartHarnessesDeps,
): Promise<RestartOutcome> {
  const name = agent.name!;
  const existingSpec = await deps.readSpawnSpec(name);
  const classification = classifyRestartVerdict(agent, existingSpec);
  if (classification.verdict === "failed") {
    return { name, verdict: "failed", detail: classification.detail };
  }
  const liveModel = await deps.readLiveModel(agent);
  let synthesisNote = "";
  if (existingSpec === null) {
    const synthesizedSpec = await synthesizeSpawnSpec(agent, liveModel, deps);
    await deps.writeSpawnSpec(name, synthesizedSpec);
    synthesisNote = "; a spawn record was created from herdr and the live transcript";
  } else {
    await recordLiveSessionAndModel(name, existingSpec, agent.sessionId!, liveModel, deps);
  }
  await stopHarnessInPane(agent.paneId, deps);
  await deps.resume(name);
  await ensurePaneCarriesName(agent, name, deps);
  const modelNote = existingSpec !== null && liveModel !== undefined && liveModel !== existingSpec.model ? ` on ${liveModel} (was ${existingSpec.model})` : "";
  return { name, verdict: "restarted", detail: `resumed native session ${agent.sessionId}${modelNote}${synthesisNote}` };
}

async function restartRegentUnderLock(
  agent: HerdrAgent,
  deps: RestartHarnessesDeps,
): Promise<RestartOutcome> {
  const token = await deps.acquireRegentRestartLock();
  if (token === null) {
    return { name: agent.name!, verdict: "skipped", detail: "the Regent resurrect lock is held; a resurrection is already in flight" };
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
  for (const agent of targets) {
    if (agent.paneId === invokingPaneId) deps.log(beforeSelfStopMessage(agent));
    const outcome = await restartOne(agent, deps);
    (outcome.verdict === "failed" ? deps.warn : deps.log)(renderOutcome(outcome));
    outcomes.push(outcome);
  }
  return outcomes;
}

export async function run(
  args: readonly string[],
  deps: RestartHarnessesDeps = REAL_DEPS,
): Promise<number> {
  let options: RestartHarnessesOptions;
  try {
    options = parseRestartHarnessesArguments(args);
  } catch (error) {
    deps.warn(`restart-harnesses: ${errorText(error)}\n`);
    return 2;
  }
  const outcomes = await restartHarnesses(options, deps);
  return outcomes.some((outcome) => outcome.verdict === "failed") ? 1 : 0;
}
