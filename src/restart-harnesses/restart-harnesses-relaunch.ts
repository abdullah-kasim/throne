import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { HARNESS_PROVENANCE_STATES } from "../herdr/harness-provenance.ts";
import {
  sameAgentName,
  type HerdrAgent,
} from "../herdr/herdr-identity-contracts.ts";
import { REGENT_NAME } from "../regent-state/regent-state.service.ts";
import { errorText } from "../shared-policy/error-text.ts";
import type {
  RestartHarnessesDeps,
  RestartOutcome,
  RestartVerdict,
} from "./restart-harnesses-runtime.ts";

export function isRegent(agent: HerdrAgent): boolean {
  return agent.name !== undefined && sameAgentName(agent.name, REGENT_NAME);
}

export function regentSkippedForHeldLock(agent: HerdrAgent): RestartOutcome {
  return {
    name: agent.name!,
    verdict: "skipped",
    detail: "the Regent resurrect lock is held; a resurrection is already in flight",
  };
}

async function applyConfiguredEffort(
  agent: HerdrAgent,
  name: string,
  deps: RestartHarnessesDeps,
): Promise<string> {
  const spec = await deps.readSpawnSpec(name);
  if (spec === null) return "";
  const effort = await deps.configuredEffort(name, isRegent(agent) ? "regent" : undefined, spec);
  if (effort === undefined || effort === spec.effort) return "";
  await deps.writeSpawnSpec(name, { ...spec, effort });
  return ` at effort ${effort} (was ${spec.effort})`;
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

export type ResumeInTabDeps = Pick<
  RestartHarnessesDeps,
  "resume" | "listAgents" | "renameAgent"
>;

export async function ensurePaneCarriesName(
  agent: Pick<HerdrAgent, "tabId">,
  name: string,
  deps: Pick<ResumeInTabDeps, "listAgents" | "renameAgent">,
): Promise<string> {
  const agents = await deps.listAgents();
  const named = agents.find((candidate) => candidate.name !== undefined && sameAgentName(candidate.name, name));
  if (named !== undefined) return named.paneId;
  const inTab = agents.filter((candidate) => candidate.tabId === agent.tabId);
  if (inTab.length !== 1) {
    throw new Error(`after the relaunch, tab "${agent.tabId}" holds ${inTab.length} agents and none is named "${name}"`);
  }
  await deps.renameAgent(inTab[0]!.paneId, name);
  return inTab[0]!.paneId;
}

export async function resumeAgentInItsTab(
  name: string,
  tabId: string,
  deps: ResumeInTabDeps,
): Promise<string> {
  await deps.resume(name);
  return ensurePaneCarriesName({ tabId }, name, deps);
}

async function binaryRunningInPane(
  paneId: string,
  launchedOnCustomExecutable: boolean,
  deps: Pick<RestartHarnessesDeps, "harnessProvenance">,
): Promise<string> {
  const provenance = await deps.harnessProvenance(paneId);
  if (provenance.state === HARNESS_PROVENANCE_STATES.NO_HARNESS) {
    throw new Error(`relaunched, but pane "${paneId}" shows no harness process`);
  }
  if (provenance.state === HARNESS_PROVENANCE_STATES.FOREIGN && !launchedOnCustomExecutable) {
    throw new Error(`relaunched on ${provenance.executablePath}, which is not the vendored binary`);
  }
  return provenance.executablePath!;
}

const NO_SESSION_ID_DETAIL = "herdr reports no native session id, so an exact resume is impossible";
const SYNTHESIS_DETAIL = "a spawn record will be synthesized from herdr and the live transcript";

export function classifyRestartVerdict(
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

async function relaunchInItsTab(
  agent: HerdrAgent,
  deps: RestartHarnessesDeps,
  stopRunningHarness: () => Promise<void>,
): Promise<RestartOutcome> {
  const name = agent.name!;
  const existingSpec = await deps.readSpawnSpec(name);
  const classification = classifyRestartVerdict(agent, existingSpec);
  if (classification.verdict === "failed") {
    return { name, verdict: "failed", detail: classification.detail };
  }
  const liveModel = await deps.readLiveModel(agent, existingSpec?.account);
  let synthesisNote = "";
  if (existingSpec === null) {
    const synthesizedSpec = await synthesizeSpawnSpec(agent, liveModel, deps);
    await deps.writeSpawnSpec(name, synthesizedSpec);
    synthesisNote = "; a spawn record was created from herdr and the live transcript";
  } else {
    await recordLiveSessionAndModel(name, existingSpec, agent.sessionId!, liveModel, deps);
  }
  const effortNote = await applyConfiguredEffort(agent, name, deps);
  await stopRunningHarness();
  const relaunchedPaneId = await resumeAgentInItsTab(name, agent.tabId, deps);
  const launchedOnCustomExecutable = existingSpec?.harness_executable !== undefined;
  const runningBinary = await binaryRunningInPane(relaunchedPaneId, launchedOnCustomExecutable, deps);
  const modelNote = existingSpec !== null && liveModel !== undefined && liveModel !== existingSpec.model ? ` on ${liveModel} (was ${existingSpec.model})` : "";
  return { name, verdict: "restarted", detail: `resumed native session ${agent.sessionId}${modelNote}${effortNote}${synthesisNote}; running ${runningBinary}` };
}

export async function relaunchAgent(
  agent: HerdrAgent,
  deps: RestartHarnessesDeps,
  stopRunningHarness: () => Promise<void> = async () => undefined,
): Promise<RestartOutcome> {
  try {
    return await relaunchInItsTab(agent, deps, stopRunningHarness);
  } catch (error) {
    return { name: agent.name!, verdict: "failed", detail: errorText(error) };
  }
}
