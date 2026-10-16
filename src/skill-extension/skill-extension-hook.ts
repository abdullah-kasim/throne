import { findSkillExtension, type SkillExtension } from "../shared-policy/skill-extensions.ts";

const SKILL_TOOL_EVENT = "PreToolUse";
const SLASH_COMMAND_EVENT = "UserPromptExpansion";
const SKILL_TOOL_NAME = "Skill";

interface HookEvent {
  readonly eventName: string;
  readonly skillName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function skillNameOfEvent(hookInput: Record<string, unknown>): string | undefined {
  const eventName = stringField(hookInput, "hook_event_name");
  if (eventName === SLASH_COMMAND_EVENT) return stringField(hookInput, "command_name");
  if (eventName !== SKILL_TOOL_EVENT || stringField(hookInput, "tool_name") !== SKILL_TOOL_NAME) return undefined;
  const toolInput = hookInput["tool_input"];
  return isRecord(toolInput) ? stringField(toolInput, "skill") : undefined;
}

function parseHookEvent(hookInputText: string): HookEvent | undefined {
  let hookInput: unknown;
  try {
    hookInput = JSON.parse(hookInputText);
  } catch {
    return undefined;
  }
  if (!isRecord(hookInput)) return undefined;
  const skillName = skillNameOfEvent(hookInput);
  const eventName = stringField(hookInput, "hook_event_name");
  return skillName === undefined || eventName === undefined ? undefined : { eventName, skillName };
}

export async function skillExtensionHookOutput(
  hookInputText: string,
  environment: NodeJS.ProcessEnv,
  renderSkillExtension: (extension: SkillExtension) => string,
): Promise<string> {
  const hookEvent = parseHookEvent(hookInputText);
  if (hookEvent === undefined) return "";
  let extension: SkillExtension | undefined;
  try {
    extension = await findSkillExtension(hookEvent.skillName, environment);
  } catch {
    return "";
  }
  if (extension === undefined) return "";
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: hookEvent.eventName,
      additionalContext: renderSkillExtension(extension),
    },
  })}\n`;
}
