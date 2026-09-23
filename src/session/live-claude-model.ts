import { readFile } from "node:fs/promises";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { latestObservedClaudeModel } from "./claude-runtime-model-attestation.ts";
import { claudeTranscriptPathFor } from "./runtime-model-acceptance.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";

export async function readLiveClaudeModel(
  agent: HerdrAgent,
): Promise<string | undefined> {
  if (agent.agent !== HARNESS_NAMES.CLAUDE) return undefined;
  try {
    const transcriptPath = await claudeTranscriptPathFor(
      agent.cwd,
      agent.sessionId,
    );
    if (transcriptPath === undefined) return undefined;
    return latestObservedClaudeModel(await readFile(transcriptPath, "utf8"));
  } catch {
    return undefined;
  }
}
