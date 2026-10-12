import { spawn } from "node:child_process";
import { loadUserConfigFile } from "../user-config-loader.ts";
import { ForgeRefusal, messageOf } from "./forge-refusal.ts";

export const DEFAULT_EDITOR = "code";

const QUOTED_OR_BARE_WORD = /"([^"]*)"|'([^']*)'|(\S+)/g;

export function editorCommandOf(
  explicit: string | undefined,
  configured: string | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  return [explicit, configured, environment.VISUAL].find(isNonEmpty) ?? DEFAULT_EDITOR;
}

export async function configuredEditor(configPath?: string): Promise<string | undefined> {
  return (await loadUserConfigFile(configPath))?.editor;
}

function wordsOfCommand(command: string): string[] {
  return [...command.matchAll(QUOTED_OR_BARE_WORD)].map((match) => match[1] ?? match[2] ?? match[3]);
}

export async function launchEditor(worktree: string, command: string): Promise<void> {
  const [program, ...editorArguments] = wordsOfCommand(command);
  if (program === undefined) throw new ForgeRefusal("the editor command is empty");
  const editor = spawn(program, [...editorArguments, worktree], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    editor.once("spawn", resolve);
    editor.once("error", (error) => reject(new ForgeRefusal(`could not launch the editor "${command}": ${messageOf(error)}`)));
  });
  editor.unref();
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}
