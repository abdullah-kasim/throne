import { text as readStreamAsText } from "node:stream/consumers";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import {
  findSkillExtension,
  isPlainSkillName,
  listSkillExtensions,
  type SkillExtension,
  type SkillExtensionEntry,
} from "../shared-policy/skill-extensions.ts";
import { skillExtensionHookOutput } from "./skill-extension-hook.ts";

const LIST_FLAG = "--list";
const HOOK_FLAG = "--hook";
const SUCCESS = 0;
const REFUSED = 2;

export interface SkillExtensionDependencies {
  readonly environment: NodeJS.ProcessEnv;
  readStdin(): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const PRODUCTION_DEPENDENCIES: SkillExtensionDependencies = {
  environment: process.env,
  readStdin: () => readStreamAsText(process.stdin),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

export const USAGE =
  "Usage: throne skill-extension <skill-name> | --list | --hook\n" +
  "Prints the operator's extension to a skill, a Markdown file named for the skill in the throne home's\n" +
  "skill-extensions folder: one line naming the file, then its content. Prints nothing when there is none.\n" +
  "--list prints one line per extension present: the skill name and the file.\n" +
  "--hook reads a Claude Code skill-loading hook event on stdin and prints the same text as added context.\n";

type SkillExtensionRequest =
  | { readonly kind: "list" }
  | { readonly kind: "hook" }
  | { readonly kind: "find"; readonly skillName: string };

function parseSkillExtensionRequest(commandArguments: readonly string[]): SkillExtensionRequest {
  if (commandArguments.length !== 1) {
    throw new Error("name exactly one skill, or pass --list alone");
  }
  const [argument] = commandArguments as [string];
  if (argument === LIST_FLAG) return { kind: "list" };
  if (argument === HOOK_FLAG) return { kind: "hook" };
  if (argument.startsWith("-")) throw new Error(`unknown flag "${argument}"`);
  if (!isPlainSkillName(argument)) {
    throw new Error(`"${argument}" is not a plain skill name, so it could reach outside the skill-extensions folder`);
  }
  return { kind: "find", skillName: argument };
}

function renderSkillExtension(extension: SkillExtension): string {
  return `Operator extension for the ${extension.skillName} skill, from ${extension.path}:\n${extension.content}`;
}

function renderSkillExtensionList(entries: readonly SkillExtensionEntry[]): string {
  return entries.map((entry) => `${entry.skillName}: ${entry.path}\n`).join("");
}

function refuseSkillExtensionRequest(error: unknown, dependencies: SkillExtensionDependencies): number {
  dependencies.writeStderr(USAGE);
  dependencies.writeStderr(
    `${renderEntranceRefusal({
      reason: `skill-extension refused: ${error instanceof Error ? error.message : String(error)}.`,
      bypass: undefined,
      supervisorRoute: "Name one skill by its folder name, or pass --list.",
    })}\n`,
  );
  return REFUSED;
}

export async function runSkillExtension(
  commandArguments: readonly string[],
  dependencies: SkillExtensionDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let request: SkillExtensionRequest;
  try {
    request = parseSkillExtensionRequest(commandArguments);
  } catch (error) {
    return refuseSkillExtensionRequest(error, dependencies);
  }
  if (request.kind === "hook") {
    const hookInputText = await dependencies.readStdin().catch(() => "");
    dependencies.writeStdout(
      await skillExtensionHookOutput(hookInputText, dependencies.environment, renderSkillExtension),
    );
    return SUCCESS;
  }
  if (request.kind === "list") {
    dependencies.writeStdout(renderSkillExtensionList(await listSkillExtensions(dependencies.environment)));
    return SUCCESS;
  }
  const extension = await findSkillExtension(request.skillName, dependencies.environment);
  if (extension !== undefined) dependencies.writeStdout(renderSkillExtension(extension));
  return SUCCESS;
}
