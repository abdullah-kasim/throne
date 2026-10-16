import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { REGENT_TAB_LABEL } from "../regent-state/regent-liveness.ts";
import {
  AGENT_ROLES,
  AGENT_ROLE_NAMES,
  AGENT_SETTING_CORRECTION_KINDS,
  type ActualAgentSettings,
  type AgentColourByRole,
  type AgentRole,
  type AgentSettingCorrection,
  type AgentSettingCorrectionKind,
  type DesiredAgentSettings,
  type RecordedAgent,
} from "./agent-settings.types.ts";

const HARNESS_COMMAND_BY_CORRECTION_KIND: Readonly<
  Record<AgentSettingCorrectionKind, string>
> = {
  [AGENT_SETTING_CORRECTION_KINDS.SET_COLOUR]: "/color",
  [AGENT_SETTING_CORRECTION_KINDS.SET_SESSION_NAME]: "/rename",
};

const NO_COLOUR_IS_NEEDED_TO_NAME_A_SESSION: AgentColourByRole = {};

export function agentRoleNamed(
  recordedRole: string | undefined,
): AgentRole | undefined {
  const wantedName = recordedRole?.trim().toLowerCase();
  return AGENT_ROLE_NAMES.find((role) => role.toLowerCase() === wantedName);
}

export function desiredAgentSettings(
  recordedAgent: RecordedAgent,
  colourByRole: AgentColourByRole,
): DesiredAgentSettings | undefined {
  const role = agentRoleNamed(recordedAgent.role);
  if (role === undefined) return undefined;
  const tabName =
    role === AGENT_ROLES.REGENT ? REGENT_TAB_LABEL : recordedAgent.tabName;
  return {
    agentName: recordedAgent.agentName,
    role,
    tabName,
    harness: recordedAgent.harness,
    colour: colourByRole[role],
    sessionName: tabName,
  };
}

export function sessionNameAtLaunch(
  agentName: string,
  role: string | undefined,
  harness: string,
): string | undefined {
  return desiredAgentSettings(
    { agentName, role, tabName: agentName, harness },
    NO_COLOUR_IS_NEEDED_TO_NAME_A_SESSION,
  )?.sessionName;
}

export function isAgentCorrectable(
  desired: DesiredAgentSettings,
  actual: ActualAgentSettings,
): boolean {
  return actual.alive && desired.harness === HARNESS_NAMES.CLAUDE;
}

export function correctionsFor(
  desired: DesiredAgentSettings,
  actual: ActualAgentSettings,
): AgentSettingCorrection[] {
  if (!isAgentCorrectable(desired, actual)) return [];
  const corrections: AgentSettingCorrection[] = [];
  if (desired.colour !== undefined && actual.colour !== desired.colour) {
    corrections.push({
      kind: AGENT_SETTING_CORRECTION_KINDS.SET_COLOUR,
      name: desired.colour,
    });
  }
  if (actual.sessionName !== desired.sessionName) {
    corrections.push({
      kind: AGENT_SETTING_CORRECTION_KINDS.SET_SESSION_NAME,
      name: desired.sessionName,
    });
  }
  return corrections;
}

export function harnessCommandFor(correction: AgentSettingCorrection): string {
  return `${HARNESS_COMMAND_BY_CORRECTION_KIND[correction.kind]} ${correction.name}`;
}
