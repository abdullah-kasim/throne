import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TOPIC_VERDICTS_FILE_NAME } from "../topic/topic.command.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { claudeProjectsFolderOf } from "../account/agent-account.ts";
import { claudeTranscriptPathFor } from "../session/runtime-model-acceptance.ts";

export const DRIFT_PROMPT_BASENAME = "lord-prompt.md";

export type LocateOriginTranscript = (originName: string) => Promise<string | undefined>;

interface TopicVerdictRecord {
  verdict: string;
  at: string;
}

export function topicChanged(record: TopicVerdictRecord | undefined): record is TopicVerdictRecord {
  return record?.verdict === "changed";
}

export async function readLatestTopicVerdict(
  originName: string,
  dataDir: string,
): Promise<TopicVerdictRecord | undefined> {
  const text = await readFile(path.join(dataDir, originName, TOPIC_VERDICTS_FILE_NAME), "utf8").catch(() => "");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  return last === undefined ? undefined : (JSON.parse(last) as TopicVerdictRecord);
}

function typedText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((part) => part?.type === "text").map((part) => part.text as string);
  return parts.length === content.length && parts.length > 0 ? parts.join("") : undefined;
}

export function lastLordPromptBefore(transcript: string, time: string): string | undefined {
  let found: string | undefined;
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const queued = entry.type === "attachment" && entry.attachment?.type === "queued_command";
    const origin = queued ? entry.attachment.origin : entry.origin;
    if ((entry.type !== "user" && !queued) || origin?.kind !== "human" || entry.isMeta === true) continue;
    if (typeof entry.timestamp !== "string" || Date.parse(entry.timestamp) > Date.parse(time)) continue;
    const text = queued ? typedText(entry.attachment.prompt) : typedText(entry.message?.content);
    if (text !== undefined) found = text;
  }
  return found;
}

export async function locateOriginClaudeTranscript(
  originName: string,
  dataDir: string,
): Promise<string | undefined> {
  const agent = await resolveAgent(originName);
  if (agent.agent !== HARNESS_NAMES.CLAUDE) return undefined;
  const spawn = await readSpawnSpec(originName, dataDir);
  return claudeTranscriptPathFor(agent.cwd, agent.sessionId, claudeProjectsFolderOf(spawn?.account));
}

export async function copyDriftPrompt(
  originName: string,
  forkName: string,
  dataDir: string,
  locateTranscript: LocateOriginTranscript = (name) => locateOriginClaudeTranscript(name, dataDir),
): Promise<string | undefined> {
  try {
    const verdict = await readLatestTopicVerdict(originName, dataDir);
    if (!topicChanged(verdict)) return undefined;
    const transcriptPath = await locateTranscript(originName);
    if (transcriptPath === undefined) return undefined;
    const prompt = lastLordPromptBefore(await readFile(transcriptPath, "utf8"), verdict.at);
    if (prompt === undefined) return undefined;
    const target = path.join(dataDir, forkName, DRIFT_PROMPT_BASENAME);
    await writeFile(target, prompt, "utf8");
    return target;
  } catch {
    return undefined;
  }
}
