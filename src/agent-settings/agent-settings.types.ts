export const AGENT_ROLES = {
  REGENT: "Regent",
  STAGER: "Stager",
  ALPHA: "Alpha",
  SHADOW: "Shadow",
} as const;

export type AgentRole = (typeof AGENT_ROLES)[keyof typeof AGENT_ROLES];

export const AGENT_ROLE_NAMES: readonly AgentRole[] = Object.values(AGENT_ROLES);

export type AgentColourByRole = Readonly<Partial<Record<AgentRole, string>>>;

export interface RecordedAgent {
  readonly agentName: string;
  readonly role: string | undefined;
  readonly tabName: string;
  readonly harness: string;
}

export interface DesiredAgentSettings {
  readonly agentName: string;
  readonly role: AgentRole;
  readonly tabName: string;
  readonly harness: string;
  readonly colour: string | undefined;
  readonly sessionName: string;
}

export interface ActualAgentSettings {
  readonly alive: boolean;
  readonly colour: string | undefined;
  readonly sessionName: string | undefined;
}

export const AGENT_SETTING_CORRECTION_KINDS = {
  SET_COLOUR: "set-colour",
  SET_SESSION_NAME: "set-session-name",
} as const;

export type AgentSettingCorrectionKind =
  (typeof AGENT_SETTING_CORRECTION_KINDS)[keyof typeof AGENT_SETTING_CORRECTION_KINDS];

export interface AgentSettingCorrection {
  readonly kind: AgentSettingCorrectionKind;
  readonly name: string;
}
