import { readFile } from "node:fs/promises";
import { isInWindow, type WorkLogWindow } from "./work-log-window.ts";

export const GITHUB_ACTION_LOG_FILE_NAME = "github-actions.jsonl";

export interface GithubAction {
  readonly timestamp: string;
  readonly agent: string | null;
  readonly host: string | null;
  readonly repo: string | null;
  readonly subcommand: string;
  readonly pr: number | null;
  readonly exit_code: number;
}

export interface GithubActionsInWindow {
  readonly actions: GithubAction[];
  readonly malformedLineCount: number;
}

async function readLogTextOrNothing(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function isGithubAction(value: unknown): value is GithubAction {
  const candidate = value as Partial<GithubAction> | null;
  return (
    typeof candidate?.timestamp === "string" &&
    !Number.isNaN(Date.parse(candidate.timestamp)) &&
    typeof candidate.subcommand === "string" &&
    Number.isInteger(candidate.exit_code)
  );
}

function parseGithubAction(line: string): GithubAction | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isGithubAction(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function readGithubActionsInWindow(
  filePath: string,
  window: WorkLogWindow,
): Promise<GithubActionsInWindow> {
  const lines = (await readLogTextOrNothing(filePath)).split("\n").filter((line) => line.trim() !== "");
  const actions: GithubAction[] = [];
  let malformedLineCount = 0;
  for (const line of lines) {
    const action = parseGithubAction(line);
    if (action === undefined) malformedLineCount += 1;
    else if (isInWindow(Date.parse(action.timestamp), window)) actions.push(action);
  }
  return { actions, malformedLineCount };
}
