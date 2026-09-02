import { styledLinesFromAnsi } from "../codex-screen/composer/ansi.ts";

export const FASTER_MODEL_REPAINT_OBSERVATION_MS = 150;
export const FASTER_MODEL_CLEAR_POLL_MS = 500;
export const FASTER_MODEL_CLEAR_TIMEOUT_MS = 1_500;

export interface FasterModelDismissTarget {
  readonly paneId: string;
}

export interface FasterModelDismissDependencies {
  readVisibleAgentAnsi(target: string): Promise<string>;
  readVisibleCodexAgentAnsi?(target: string): Promise<string>;
  pressPaneKey: (pane: string, key: string) => Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

function readVisibleCodexAgentAnsi(
  deps: FasterModelDismissDependencies,
  target: string,
): Promise<string> {
  return (deps.readVisibleCodexAgentAnsi ?? deps.readVisibleAgentAnsi)(target);
}

function renderedLines(text: string): string[] {
  return styledLinesFromAnsi(text)
    .map((line) => line.map(({ value }) => value).join(""))
    .map((line) => line.replace(/[│┃╎╏┆┇┊┋]/gu, " "))
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .filter((line, index, lines) => line !== lines[index - 1]);
}

function normalizedText(text: string): string {
  return renderedLines(text)
    .join(" ")
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function wordSet(text: string): Set<string> {
  return new Set(normalizedText(text).split(" ").filter(Boolean));
}

export function textMostlyMatch(textA: string, textB: string): boolean {
  const wordsA = wordSet(textA);
  const wordsB = wordSet(textB);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let shared = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) shared += 1;
  }
  return shared / Math.max(wordsA.size, wordsB.size) >= 0.72;
}

function numberedOptions(text: string): number[] {
  return [...text.matchAll(/(?:^|\s)(\d+)\s*[).:-]?\s+\p{L}/gu)].map((match) =>
    Number(match[1]),
  );
}

function onlyRepeatedRetryDismissOptions(options: readonly number[]): boolean {
  return options.length === 2 && options[0] === 1 && options[1] === 2;
}

export function recognizesFasterModelInterruption(text: string): boolean {
  const normalized = normalizedText(text);
  const options = numberedOptions(normalized);
  return (
    !normalized.startsWith("model selection ") &&
    onlyRepeatedRetryDismissOptions(options) &&
    /\b1\s+(?:retry|try again)\b.*\bfaster\b.*\bmodel\b.*\b2\s+(?:dismiss|keep waiting)\b/u.test(
      normalized,
    )
  );
}

function compatibleInterruptionFrames(first: string, second: string): boolean {
  return (
    recognizesFasterModelInterruption(first) &&
    recognizesFasterModelInterruption(second) &&
    textMostlyMatch(first, second)
  );
}

export async function dismissFasterModelInterruption(
  target: FasterModelDismissTarget,
  deps: FasterModelDismissDependencies,
  firstObservation?: string,
): Promise<boolean> {
  const first =
    firstObservation ?? (await readVisibleCodexAgentAnsi(deps, target.paneId));
  if (!recognizesFasterModelInterruption(first)) return false;
  await deps.sleep(FASTER_MODEL_REPAINT_OBSERVATION_MS);
  const second = await readVisibleCodexAgentAnsi(deps, target.paneId);
  if (!compatibleInterruptionFrames(first, second)) return false;

  await deps.pressPaneKey(target.paneId, "2");
  const deadline = deps.now() + FASTER_MODEL_CLEAR_TIMEOUT_MS;
  while (true) {
    const visible = await readVisibleCodexAgentAnsi(deps, target.paneId);
    if (!recognizesFasterModelInterruption(visible)) return true;
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(
        "faster-model interruption remained after option 2 Dismiss",
      );
    }
    await deps.sleep(Math.min(FASTER_MODEL_CLEAR_POLL_MS, remaining));
  }
}
