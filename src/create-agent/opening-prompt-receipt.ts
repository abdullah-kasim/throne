import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_DATA_DIR,
  readSpawnSpec,
} from "../agentdata/spawn-data-contracts.ts";
import { claudeTranscriptPathFor } from "../session/runtime-model-acceptance.ts";

export type OpeningPromptReceipt =
  | { status: "intact"; transcriptPath: string }
  | { status: "clipped"; receivedText: string; transcriptPath: string }
  | { status: "unobserved"; reason: string };

interface ClaudeTranscriptUserRecord {
  type?: unknown;
  isMeta?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
}

export const CLIPPED_OPENING_PROMPT_PREFACE =
  "Your opening prompt reached your composer clipped (the harness dropped part of the pasted text at startup). " +
  "Disregard the fragment you received and take this complete version as your opening prompt:";

export function resendOpeningPromptAfterClipping(openingPrompt: string): string {
  return `${CLIPPED_OPENING_PROMPT_PREFACE}\n\n${openingPrompt}`;
}

function textOfContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const textBlocks = content.filter(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  if (textBlocks.length === 0) return undefined;
  return textBlocks.map((block) => block.text).join("");
}

export function firstUserTurnText(transcript: string): string | undefined {
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let record: ClaudeTranscriptUserRecord;
    try {
      record = JSON.parse(line) as ClaudeTranscriptUserRecord;
    } catch {
      continue;
    }
    if (record.type !== "user" || record.isMeta === true) continue;
    if (record.message?.role !== "user") continue;
    const text = textOfContent(record.message.content);
    if (text !== undefined) return text;
  }
  return undefined;
}

export function normalizePromptText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function compareOpeningPromptReceipt(
  openingPrompt: string,
  transcript: string,
  transcriptPath: string,
): OpeningPromptReceipt {
  const receivedText = firstUserTurnText(transcript);
  if (receivedText === undefined) {
    return { status: "unobserved", reason: "no user turn recorded yet" };
  }
  if (normalizePromptText(receivedText) === normalizePromptText(openingPrompt)) {
    return { status: "intact", transcriptPath };
  }
  return { status: "clipped", receivedText, transcriptPath };
}

export interface OpeningPromptReceiptDeps {
  baseDir?: string;
  projectsDir?: string;
  pollIntervalMs?: number;
  deadlineMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const OPENING_PROMPT_RECEIPT_POLL_INTERVAL_MS = 3_000;
const OPENING_PROMPT_RECEIPT_DEADLINE_MS = 90_000;

function sleepRealTime(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readOpeningPromptReceiptOnce(
  name: string,
  openingPrompt: string,
  baseDir: string,
  projectsDir: string,
): Promise<OpeningPromptReceipt> {
  const spawn = await readSpawnSpec(name, baseDir);
  if (spawn === null) {
    return { status: "unobserved", reason: `no spawn record for "${name}"` };
  }
  const transcriptPath = await claudeTranscriptPathFor(
    spawn.cwd,
    spawn.session_id,
    projectsDir,
  );
  if (transcriptPath === undefined) {
    return { status: "unobserved", reason: "no transcript written yet" };
  }
  return compareOpeningPromptReceipt(
    openingPrompt,
    await readFile(transcriptPath, "utf8"),
    transcriptPath,
  );
}

export async function awaitOpeningPromptReceipt(
  name: string,
  openingPrompt: string,
  deps: OpeningPromptReceiptDeps = {},
): Promise<OpeningPromptReceipt> {
  const baseDir = deps.baseDir ?? DEFAULT_DATA_DIR;
  const projectsDir =
    deps.projectsDir ?? path.join(homedir(), ".claude", "projects");
  const pollIntervalMs =
    deps.pollIntervalMs ?? OPENING_PROMPT_RECEIPT_POLL_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? OPENING_PROMPT_RECEIPT_DEADLINE_MS;
  const sleep = deps.sleep ?? sleepRealTime;
  const now = deps.now ?? Date.now;
  const deadlineAt = now() + deadlineMs;
  let receipt: OpeningPromptReceipt = {
    status: "unobserved",
    reason: "receipt never checked",
  };
  while (true) {
    try {
      receipt = await readOpeningPromptReceiptOnce(
        name,
        openingPrompt,
        baseDir,
        projectsDir,
      );
    } catch (error) {
      receipt = {
        status: "unobserved",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (receipt.status !== "unobserved" || now() >= deadlineAt) {
      return receipt;
    }
    await sleep(pollIntervalMs);
  }
}
