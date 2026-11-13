import { readFile } from "node:fs/promises";

const NOTE_ACTION = "note";

interface JournalLine {
  readonly at?: string;
  readonly action?: string;
  readonly archived?: readonly string[];
}

export interface JournalTimes {
  readonly notesNewestFirst: readonly Date[];
  readonly archivedAt: ReadonlyMap<string, Date>;
}

export const NO_JOURNAL_TIMES: JournalTimes = { notesNewestFirst: [], archivedAt: new Map() };

export async function readJournalTimes(journalFile: string | undefined): Promise<JournalTimes> {
  if (journalFile === undefined) return NO_JOURNAL_TIMES;
  const lines = (await readFile(journalFile, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JournalLine)
    .filter((line) => line.at !== undefined && !Number.isNaN(new Date(line.at).getTime()));
  const archivedAt = new Map<string, Date>();
  for (const line of lines) {
    for (const identity of line.archived ?? []) archivedAt.set(identity, new Date(line.at!));
  }
  const notesNewestFirst = lines
    .filter((line) => line.action === NOTE_ACTION)
    .map((line) => new Date(line.at!))
    .sort((first, second) => second.getTime() - first.getTime());
  return { notesNewestFirst, archivedAt };
}
