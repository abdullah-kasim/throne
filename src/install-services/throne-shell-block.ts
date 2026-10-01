import path from "node:path";
import { shellQuote } from "../herdr/herdr-launch-command.ts";
import {
  PUT_LIVE_BIN_FIRST_FUNCTION,
  sessionEnvExportLines,
} from "../throne-startup/session-env-export.ts";

export const THRONE_SHELL_BLOCK_START = "# >>> throne herdr session >>>";
export const THRONE_SHELL_BLOCK_END = "# <<< throne herdr session <<<";
const THRONE_HERDR_SESSION_NAME = "throne";

export function throneSessionFilePath(liveRoot: string): string {
  return path.join(liveRoot, "shell", "throne-session.bash");
}

function putLiveBinFirstAfterEveryPromptLine(): string {
  const promptHookAlreadyAdded = `[[ \${PROMPT_COMMAND:-} == *${PUT_LIVE_BIN_FIRST_FUNCTION}* ]]`;
  const addPromptHookLast = `PROMPT_COMMAND=\${PROMPT_COMMAND:+\${PROMPT_COMMAND}$'\\n'}${PUT_LIVE_BIN_FIRST_FUNCTION}`;
  return `${promptHookAlreadyAdded} || ${addPromptHookLast}`;
}

export function throneSessionFileText(liveRoot: string): string {
  const lines = [...sessionEnvExportLines({ liveRoot }), putLiveBinFirstAfterEveryPromptLine()];
  return `${lines.join("\n")}\n`;
}

export function throneShellBlock(liveRoot: string): string {
  const sessionFile = shellQuote(throneSessionFilePath(liveRoot));
  const guardedSource = `[ "\${HERDR_SESSION:-}" = ${THRONE_HERDR_SESSION_NAME} ] && [ -f ${sessionFile} ] && . ${sessionFile}`;
  return `${THRONE_SHELL_BLOCK_START}\n${guardedSource}\n${THRONE_SHELL_BLOCK_END}\n`;
}

interface MarkedRegion {
  start: number;
  end: number;
}

function findMarkedRegion(rcText: string): MarkedRegion | undefined {
  const start = rcText.indexOf(THRONE_SHELL_BLOCK_START);
  if (start === -1) return undefined;
  const endMarker = rcText.indexOf(THRONE_SHELL_BLOCK_END, start);
  if (endMarker === -1) return undefined;
  const afterEndMarker = endMarker + THRONE_SHELL_BLOCK_END.length;
  const end = rcText[afterEndMarker] === "\n" ? afterEndMarker + 1 : afterEndMarker;
  return { start, end };
}

function withTrailingNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

export function upsertThroneShellBlock(rcText: string, block: string): string {
  const region = findMarkedRegion(rcText);
  if (region === undefined) return `${withTrailingNewline(rcText)}${block}`;
  return `${rcText.slice(0, region.start)}${block}${rcText.slice(region.end)}`;
}
