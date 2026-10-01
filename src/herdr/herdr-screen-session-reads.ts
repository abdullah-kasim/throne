import { CODEX_HERDR_READ_TIMEOUT_MS, runHerdrInSession, type HerdrProcessBoundary } from "./herdr-client.ts";
import { parseReadText, type ReadSource } from "./herdr-inventory.service.ts";

async function readAgentOutputInSession(
  sessionName: string,
  target: string,
  source: ReadSource,
  format: "ansi" | "text",
  lines?: number,
  processBoundary?: HerdrProcessBoundary,
  timeoutMilliseconds?: number,
): Promise<string> {
  const args = [
    "agent",
    "read",
    target,
    "--source",
    source,
    "--format",
    format,
  ];
  if (lines !== undefined) args.push("--lines", String(lines));
  const { stdout } = await runHerdrInSession(
    sessionName,
    args,
    processBoundary,
    timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds },
  );
  return parseReadText(stdout);
}

export async function readVisibleAgentAnsiInSession(
  sessionName: string,
  target: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<string> {
  return readAgentOutputInSession(sessionName, target, "visible", "ansi", undefined, processBoundary);
}

export async function readVisibleCodexAgentAnsiInSession(
  sessionName: string,
  target: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<string> {
  return readAgentOutputInSession(
    sessionName,
    target,
    "visible",
    "ansi",
    undefined,
    processBoundary,
    CODEX_HERDR_READ_TIMEOUT_MS,
  );
}

export async function readRecentAgentAnsiInSession(
  sessionName: string,
  target: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<string> {
  return readAgentOutputInSession(sessionName, target, "recent", "ansi", 1_000, processBoundary);
}

export async function readRecentCodexAgentAnsiInSession(
  sessionName: string,
  target: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<string> {
  return readAgentOutputInSession(
    sessionName,
    target,
    "recent",
    "ansi",
    1_000,
    processBoundary,
    CODEX_HERDR_READ_TIMEOUT_MS,
  );
}
