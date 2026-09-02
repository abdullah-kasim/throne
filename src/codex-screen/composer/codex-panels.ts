import { plainText, type StyledCharacter } from "./ansi.ts";
import {
  normalizeRenderedLineSequence,
  normalizeRenderedPayload,
} from "./rendered-text.ts";

const CODEX_QUEUE_HEADERS = new Set(["queued follow-up inputs"]);

const CODEX_PENDING_HEADERS = new Set([
  "messages to be submitted after next tool call",
  "messages to be submitted at end of turn",
]);

function normalizedLine(text: string): string {
  return normalizeRenderedPayload(text).toLowerCase();
}

function readNamedPanelEntries(
  lines: StyledCharacter[][],
  headers: ReadonlySet<string>,
): string[] {
  const plainLines = lines.map(plainText);
  const entries: string[] = [];
  let inPanel = false;
  let current: string[] | undefined;
  const flush = (): void => {
    if (current === undefined) {
      return;
    }
    const normalized = normalizeRenderedLineSequence(current);
    if (normalized.length > 0) {
      entries.push(normalized);
    }
    current = undefined;
  };

  for (const line of plainLines) {
    const normalized = normalizedLine(line.replace(/^\s*[•●]\s*/u, ""));
    if (headers.has(normalized)) {
      flush();
      inPanel = true;
      continue;
    }
    if (!inPanel) {
      continue;
    }
    if (/^\s*[•●]\s+/u.test(line)) {
      flush();
      inPanel = false;
      continue;
    }
    const entry = line.match(/^\s*↳\s?(.*)$/u);
    if (entry !== null) {
      flush();
      current = [entry[1] ?? ""];
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const continuation = line.trim();
    if (continuation.length === 0) {
      current.push(" ");
      continue;
    }
    if (
      /(?:edit last queued message|shortcuts|context (?:left|used))/iu.test(
        continuation,
      ) ||
      /^[›❯]/u.test(continuation)
    ) {
      flush();
      if (/^[›❯]/u.test(continuation)) {
        inPanel = false;
      }
      continue;
    }
    current.push(continuation);
  }
  flush();
  return entries;
}

export function readCodexQueuedTexts(lines: StyledCharacter[][]): string[] {
  return readNamedPanelEntries(lines, CODEX_QUEUE_HEADERS);
}

export function readCodexPendingTexts(lines: StyledCharacter[][]): string[] {
  return readNamedPanelEntries(lines, CODEX_PENDING_HEADERS);
}
