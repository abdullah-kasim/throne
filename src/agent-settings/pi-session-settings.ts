import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { piSessionDirectory } from "../create-agent/pi-launch.ts";
import { transcriptRecords, type ClaudeSessionSettings } from "./claude-session-settings.ts";

export const PI_COLOUR_ENTRY_TYPE = "throne-agent-colour";

const UNKNOWN_SESSION_SETTINGS: ClaudeSessionSettings = {
  colour: undefined,
  sessionName: undefined,
};

export async function readPiSessionSettings(
  agentName: string,
  sessionId: string,
  dataDirectory?: string,
): Promise<ClaudeSessionSettings> {
  const sessionFolder = piSessionDirectory(agentName, dataDirectory);
  try {
    const sessionFile = (await readdir(sessionFolder)).find((fileName) =>
      fileName.endsWith(`_${sessionId}.jsonl`),
    );
    if (sessionFile === undefined) return UNKNOWN_SESSION_SETTINGS;
    const records = transcriptRecords(await readFile(path.join(sessionFolder, sessionFile), "utf8"));
    const newestName = records.findLast((record) => record.type === "session_info")?.name;
    const newestColour = records.findLast(
      (record) => record.type === "custom" && record.customType === PI_COLOUR_ENTRY_TYPE,
    )?.data as { colour?: unknown } | undefined;
    return {
      colour: typeof newestColour?.colour === "string" ? newestColour.colour : undefined,
      sessionName: typeof newestName === "string" && newestName.trim() !== "" ? newestName.trim() : undefined,
    };
  } catch {
    return UNKNOWN_SESSION_SETTINGS;
  }
}
