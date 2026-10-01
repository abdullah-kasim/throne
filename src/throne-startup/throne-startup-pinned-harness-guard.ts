import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  HARNESS_PROVENANCE_STATES,
  type HarnessProvenance,
} from "../herdr/harness-provenance.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import {
  agentStatusAcceptsInput,
  type HerdrAgent,
} from "../herdr/herdr-inventory.service.ts";
import { REGENT_NAME } from "../regent-state/regent-state.service.ts";
import { errorText } from "../shared-policy/error-text.ts";

export type PinnedHarnessGuardAction =
  | "relaunch-on-pinned-harness"
  | "report-unpinned-harness";

interface PinnedHarnessGuardOutcome {
  name: string;
  action: PinnedHarnessGuardAction;
  reason: string;
  ok: boolean;
  error?: string;
}

export interface PinnedHarnessGuardContract {
  readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  harnessProvenance: (paneId: string) => Promise<HarnessProvenance>;
  currentPaneId: () => Promise<string | undefined>;
  stopHarnessInPane: (paneId: string) => Promise<void>;
  resume: (name: string) => Promise<void>;
  ensurePaneCarriesName: (agent: HerdrAgent, name: string) => Promise<void>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

type RelaunchPlan = "relaunch" | "stop-then-relaunch" | "report";

interface LiveRegisteredAgent {
  agent: HerdrAgent;
  name: string;
}

function liveRegisteredAgents(
  liveAgents: HerdrAgent[],
  registered: string[],
): LiveRegisteredAgent[] {
  return liveAgents.flatMap((agent) => {
    const liveName = agent.tabLabel ?? agent.name;
    const name =
      liveName === undefined
        ? undefined
        : registered.find((candidate) => sameAgentName(candidate, liveName));
    return name === undefined ? [] : [{ agent, name }];
  });
}

function isProtectedFromStop(
  { agent, name }: LiveRegisteredAgent,
  ownPaneId: string | undefined,
): boolean {
  return sameAgentName(name, REGENT_NAME) || agent.paneId === ownPaneId;
}

function planRelaunch(
  provenance: HarnessProvenance,
  agent: HerdrAgent,
  canBeStopped: boolean,
): RelaunchPlan {
  if (!canBeStopped) return "report";
  if (provenance.state === HARNESS_PROVENANCE_STATES.NO_HARNESS) return "relaunch";
  return agentStatusAcceptsInput(agent.agentStatus) ? "stop-then-relaunch" : "report";
}

function describeProvenance(
  provenance: HarnessProvenance,
  agent: HerdrAgent,
): string {
  return provenance.state === HARNESS_PROVENANCE_STATES.NO_HARNESS
    ? "no harness process in its pane"
    : `${agent.agentStatus} on foreign harness executable ${provenance.executablePath}`;
}

async function relaunchOnPinnedHarness(
  { agent, name }: LiveRegisteredAgent,
  plan: RelaunchPlan,
  contract: PinnedHarnessGuardContract,
): Promise<void> {
  if (plan === "stop-then-relaunch") await contract.stopHarnessInPane(agent.paneId);
  await contract.resume(name);
  await contract.ensurePaneCarriesName(agent, name);
}

async function guardOneAgent(
  liveAgent: LiveRegisteredAgent,
  ownPaneId: string | undefined,
  contract: PinnedHarnessGuardContract,
): Promise<PinnedHarnessGuardOutcome | undefined> {
  const { agent, name } = liveAgent;
  const provenance = await contract.harnessProvenance(agent.paneId);
  if (provenance.state === HARNESS_PROVENANCE_STATES.PINNED) return undefined;
  const hasRecordedRecipe = (await contract.readSpawnSpec(name)) !== null;
  const plan = planRelaunch(
    provenance,
    agent,
    hasRecordedRecipe && !isProtectedFromStop(liveAgent, ownPaneId),
  );
  const reason = `${describeProvenance(provenance, agent)} (pane ${agent.paneId})`;
  if (plan === "report") {
    contract.warn(
      `throne-startup: reconciliation — LIVE agent "${name}" is not on the pinned harness: ${reason}; left running\n`,
    );
    return { name, action: "report-unpinned-harness", reason, ok: true };
  }
  await relaunchOnPinnedHarness(liveAgent, plan, contract);
  contract.log(
    `throne-startup: reconciliation — relaunched "${name}" on the pinned harness in the same pane (${reason})\n`,
  );
  return { name, action: "relaunch-on-pinned-harness", reason, ok: true };
}

export async function relaunchLiveAgentsOffThePinnedHarness(
  liveAgents: HerdrAgent[],
  registered: string[],
  contract: PinnedHarnessGuardContract,
): Promise<PinnedHarnessGuardOutcome[]> {
  const targets = liveRegisteredAgents(liveAgents, registered);
  if (targets.length === 0) return [];
  const ownPaneId = await contract.currentPaneId();
  const outcomes: PinnedHarnessGuardOutcome[] = [];
  for (const target of targets) {
    try {
      const outcome = await guardOneAgent(target, ownPaneId, contract);
      if (outcome !== undefined) outcomes.push(outcome);
    } catch (error) {
      const message = errorText(error);
      contract.warn(
        `throne-startup: reconciliation — pinned-harness check of "${target.name}" (pane ${target.agent.paneId}) FAILED (${message}); continuing\n`,
      );
      outcomes.push({
        name: target.name,
        action: "relaunch-on-pinned-harness",
        reason: "pinned-harness check failed",
        ok: false,
        error: message,
      });
    }
  }
  return outcomes;
}
