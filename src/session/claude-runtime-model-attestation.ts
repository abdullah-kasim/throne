import { readFile } from "node:fs/promises";
import { HARNESS_NAMES, resolveModel } from "../harness-routing/harness.ts";

export type ClaudeRuntimeModelAttestation =
  | {
      status: "matching" | "mismatch";
      requestedModel: string;
      observedModels: string[];
      assistantRecords: number;
      source: string;
    }
  | {
      status: "missing";
      requestedModel: string;
      observedModels: [];
      assistantRecords: 0;
      source: string;
      reason: string;
    };

interface ClaudeTranscriptRecord {
  type?: unknown;
  message?: {
    role?: unknown;
    model?: unknown;
  };
}

const HARNESS_PLACEHOLDER_MODEL_PATTERN = /^<.+>$/;

function isHarnessPlaceholderModel(model: string): boolean {
  return HARNESS_PLACEHOLDER_MODEL_PATTERN.test(model);
}

function observedClaudeModel(
  record: ClaudeTranscriptRecord,
): string | undefined {
  if (
    record.type !== "assistant" ||
    record.message?.role !== "assistant" ||
    typeof record.message.model !== "string" ||
    record.message.model.trim() === ""
  ) {
    return undefined;
  }
  const rawModel = record.message.model.trim();
  if (isHarnessPlaceholderModel(rawModel)) {
    return undefined;
  }
  try {
    return resolveModel(HARNESS_NAMES.CLAUDE, rawModel);
  } catch {
    return rawModel.toLowerCase();
  }
}

export function latestObservedClaudeModel(transcript: string): string | undefined {
  return observedClaudeModels(transcript).at(-1);
}

function observedClaudeModels(transcript: string): string[] {
  const observed: string[] = [];
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let record: ClaudeTranscriptRecord;
    try {
      record = JSON.parse(line) as ClaudeTranscriptRecord;
    } catch {
      continue;
    }
    const model = observedClaudeModel(record);
    if (model !== undefined) observed.push(model);
  }
  return observed;
}

export function attestClaudeRuntimeModel(
  requestedModel: string,
  transcript: string,
  source: string,
): ClaudeRuntimeModelAttestation {
  const canonicalRequest = resolveModel(HARNESS_NAMES.CLAUDE, requestedModel);
  const observed = observedClaudeModels(transcript);
  if (observed.length === 0) {
    return {
      status: "missing",
      requestedModel: canonicalRequest,
      observedModels: [],
      assistantRecords: 0,
      source,
      reason: "transcript contains no assistant runtime-model record",
    };
  }
  return {
    status: observed.every((model) => model === canonicalRequest)
      ? "matching"
      : "mismatch",
    requestedModel: canonicalRequest,
    observedModels: [...new Set(observed)],
    assistantRecords: observed.length,
    source,
  };
}

export async function readClaudeRuntimeModelAttestation(
  requestedModel: string,
  transcriptPath: string,
): Promise<ClaudeRuntimeModelAttestation> {
  return attestClaudeRuntimeModel(
    requestedModel,
    await readFile(transcriptPath, "utf8"),
    transcriptPath,
  );
}
