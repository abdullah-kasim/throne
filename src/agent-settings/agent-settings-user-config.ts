import {
  describeValue,
  isPlainObject,
} from "../shared-policy/config-value-shape.ts";
import { loadUserConfigFile, resolveUserConfigPath } from "../user-config-loader.ts";
import {
  AGENT_ROLES,
  AGENT_ROLE_NAMES,
  type AgentColourByRole,
  type AgentRole,
} from "./agent-settings.types.ts";

export interface AgentSettingsConfig {
  readonly checkEnabled: boolean;
  readonly colourByRole: AgentColourByRole;
}

export type AgentSettingsConfigOverride = Partial<AgentSettingsConfig>;

export const DEFAULT_AGENT_SETTINGS_CONFIG: AgentSettingsConfig = {
  checkEnabled: true,
  colourByRole: {
    [AGENT_ROLES.REGENT]: "red",
    [AGENT_ROLES.STAGER]: "green",
    [AGENT_ROLES.ALPHA]: "blue",
    [AGENT_ROLES.SHADOW]: "purple",
  },
};

const ONE_WORD = /^[A-Za-z]+$/;

function invalidAgentSettingsConfig(
  sourcePath: string,
  field: string,
  expectation: string,
): Error {
  return new Error(
    `Invalid agent settings config in "${sourcePath}": \`${field}\` ${expectation}.`,
  );
}

function isAgentRole(name: string): name is AgentRole {
  return (AGENT_ROLE_NAMES as readonly string[]).includes(name);
}

function validateColourByRole(
  value: unknown,
  sourcePath: string,
): AgentColourByRole {
  if (!isPlainObject(value)) {
    throw invalidAgentSettingsConfig(
      sourcePath,
      "colourByRole",
      `must be a plain object mapping roles to colours (got ${describeValue(value)})`,
    );
  }
  const colourByRole: Partial<Record<AgentRole, string>> = {};
  for (const [role, colour] of Object.entries(value)) {
    if (!isAgentRole(role)) {
      throw invalidAgentSettingsConfig(
        sourcePath,
        `colourByRole.${role}`,
        `is not a known role (expected one of: ${AGENT_ROLE_NAMES.join(", ")})`,
      );
    }
    if (typeof colour !== "string" || !ONE_WORD.test(colour)) {
      throw invalidAgentSettingsConfig(
        sourcePath,
        `colourByRole.${role}`,
        `must be a colour name of one word (got ${describeValue(colour)})`,
      );
    }
    colourByRole[role] = colour;
  }
  return colourByRole;
}

export function validateAgentSettingsOverride(
  value: Readonly<Record<string, unknown>>,
  sourcePath: string,
): AgentSettingsConfigOverride {
  const override: {
    -readonly [K in keyof AgentSettingsConfig]?: AgentSettingsConfig[K];
  } = {};
  if ("checkEnabled" in value) {
    const checkEnabled = value.checkEnabled;
    if (typeof checkEnabled !== "boolean") {
      throw invalidAgentSettingsConfig(
        sourcePath,
        "checkEnabled",
        `must be a boolean (got ${describeValue(checkEnabled)})`,
      );
    }
    override.checkEnabled = checkEnabled;
  }
  if ("colourByRole" in value) {
    override.colourByRole = validateColourByRole(value.colourByRole, sourcePath);
  }
  return override;
}

export async function loadAgentSettingsConfig(
  configPath?: string,
  cacheBustToken?: string,
): Promise<AgentSettingsConfig> {
  const resolvedPath =
    configPath ?? (await resolveUserConfigPath());
  const userConfigFile = await loadUserConfigFile(resolvedPath, cacheBustToken);
  if (userConfigFile === undefined) return DEFAULT_AGENT_SETTINGS_CONFIG;
  const override = validateAgentSettingsOverride(
    userConfigFile.agentSettings,
    resolvedPath,
  );
  return {
    checkEnabled:
      override.checkEnabled ?? DEFAULT_AGENT_SETTINGS_CONFIG.checkEnabled,
    colourByRole: {
      ...DEFAULT_AGENT_SETTINGS_CONFIG.colourByRole,
      ...override.colourByRole,
    },
  };
}
