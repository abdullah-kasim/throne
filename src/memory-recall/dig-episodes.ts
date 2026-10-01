import path from 'node:path';
import type { LoggedMemoryRead, LoggedPrompt } from './recall-report-logs.ts';

export const MEMORY_INDEX_FILE_NAME = 'MEMORY.md';
const READ_KIND = 'read';
const SEARCH_KIND = 'search';

export interface PromptAndItsDig {
  readonly prompt: LoggedPrompt;
  readonly digReads: readonly LoggedMemoryRead[];
}

export interface DigEpisodes {
  readonly prompts: readonly PromptAndItsDig[];
  readonly readsMatchedToNoPrompt: number;
}

function timeOf(at: string): number {
  return Date.parse(at);
}

function latestPromptAtOrBefore<Entry extends PromptAndItsDig>(
  sessionPrompts: readonly Entry[],
  read: LoggedMemoryRead,
): Entry | undefined {
  let latest: Entry | undefined;
  for (const entry of sessionPrompts) {
    if (timeOf(entry.prompt.at) > timeOf(read.at)) break;
    latest = entry;
  }
  return latest;
}

export function digEpisodesOf(
  prompts: readonly LoggedPrompt[],
  memoryReads: readonly LoggedMemoryRead[],
): DigEpisodes {
  const entries = prompts
    .map((prompt) => ({ prompt, digReads: [] as LoggedMemoryRead[] }))
    .sort((left, right) => timeOf(left.prompt.at) - timeOf(right.prompt.at));
  const entriesBySession = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (entry.prompt.sessionId === null) continue;
    const sessionEntries = entriesBySession.get(entry.prompt.sessionId) ?? [];
    sessionEntries.push(entry);
    entriesBySession.set(entry.prompt.sessionId, sessionEntries);
  }
  let readsMatchedToNoPrompt = 0;
  for (const read of memoryReads) {
    const owner =
      read.sessionId === null
        ? undefined
        : latestPromptAtOrBefore(entriesBySession.get(read.sessionId) ?? [], read);
    if (owner === undefined) readsMatchedToNoPrompt += 1;
    else owner.digReads.push(read);
  }
  return { prompts: entries, readsMatchedToNoPrompt };
}

export function hadDig(entry: PromptAndItsDig): boolean {
  return entry.digReads.length > 0;
}

export function isMemoryIndex(filePath: string): boolean {
  return path.basename(filePath) === MEMORY_INDEX_FILE_NAME;
}

export function isFindingRead(read: LoggedMemoryRead): boolean {
  return (
    (read.kind === READ_KIND && read.readInFull) ||
    (read.kind === SEARCH_KIND && read.returnedSomething)
  );
}

export function memoriesTheDigTurnedUp(entry: PromptAndItsDig): readonly string[] {
  return [
    ...new Set(
      entry.digReads.filter(isFindingRead).flatMap((read) => read.memoryFiles),
    ),
  ].filter((filePath) => !isMemoryIndex(filePath));
}

export function contentHashSeenBy(
  entry: PromptAndItsDig,
  memoryFile: string,
): string | undefined {
  return (
    entry.digReads
      .filter(isFindingRead)
      .map((read) => read.memoryFileHashes.get(memoryFile))
      .find((contentHash) => contentHash !== undefined) ??
    entry.prompt.contentHashOfEachDecidedFile.get(memoryFile)
  );
}
