import { waitForSettledClaudeComposer } from "../herdr/herdr-claude.service.ts";
import {
  agentStatusAcceptsInput,
  type HerdrAgent,
} from "../herdr/herdr-inventory.service.ts";
import { recipientName } from "../herdr/herdr-send.helpers.ts";
import { defaultSubmitToAgentDeps } from "../herdr/herdr-send.service.ts";
import {
  RESIDENT_COMPOSER_POLL_MS,
  type SubmitToAgentDeps,
} from "../herdr/herdr-send.types.ts";
import {
  REAL_AGENT_SETTINGS_TICK_DEPS,
  correctSettingsOfOneJustLaunchedAgent,
  type AgentSettingsTickDeps,
} from "./agent-settings-tick.ts";

export const HARNESS_READY_WAIT_AT_SPAWN_MILLISECONDS = 60_000;
export const HARNESS_DID_NOT_REPORT_ITSELF_IDLE =
  "the harness did not report itself idle before the deadline; nothing was typed";

export interface SettingsAtSpawnDeps {
  readonly check: AgentSettingsTickDeps;
  readonly waitUntilThePaneTakesACommand: (
    agent: HerdrAgent,
    deadline: number,
  ) => Promise<void>;
  readonly now: () => number;
}

export const REAL_SETTINGS_AT_SPAWN_DEPS: SettingsAtSpawnDeps = {
  check: REAL_AGENT_SETTINGS_TICK_DEPS,
  waitUntilThePaneTakesACommand: (agent, deadline) =>
    waitUntilTheClaudePaneTakesACommand(
      agent,
      deadline,
      defaultSubmitToAgentDeps(agent),
    ),
  now: () => Date.now(),
};

export async function correctSettingsRightAfterSpawn(
  agent: HerdrAgent,
  agentName: string,
  deps: SettingsAtSpawnDeps = REAL_SETTINGS_AT_SPAWN_DEPS,
): Promise<string> {
  await deps.waitUntilThePaneTakesACommand(
    agent,
    deps.now() + HARNESS_READY_WAIT_AT_SPAWN_MILLISECONDS,
  );
  return correctSettingsOfOneJustLaunchedAgent(agentName, deps.check);
}

export async function waitUntilTheClaudePaneTakesACommand(
  agent: HerdrAgent,
  deadline: number,
  deps: SubmitToAgentDeps,
): Promise<void> {
  await waitForSettledClaudeComposer(agent, deadline, deps);
  while (!(await harnessReportsItselfIdle(agent, deps))) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new Error(HARNESS_DID_NOT_REPORT_ITSELF_IDLE);
    await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
  }
}

async function harnessReportsItselfIdle(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<boolean> {
  const liveAgent = await deps.refreshRecipientIdentity(
    recipientName(agent),
    agent,
  );
  return agentStatusAcceptsInput(liveAgent.agentStatus);
}
