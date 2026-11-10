import { appendFile } from "node:fs/promises";
import path from "node:path";
import { readTextFileIfPresent } from "./file-presence.ts";
import { listEntriesAndEpics, PageSection, type PageEntry } from "./page-frame.ts";

export const JOURNAL_FILE_NAME = "where-i-stand.journal.jsonl";

export const JOURNALED_PAGE_FILE_NAME = "where-i-stand.journaled.md";
export const UNRECORDED_WRITER = "unknown";
export const LORD_WRITER = "Lord";
export const FRAME_WRITER = "where-i-stand";

export const JournalAction = {
  Write: "write",
  Note: "note",
  Edit: "edit",
  UnrecordedEdit: "unrecorded-edit",
} as const;

export type JournalActionName = (typeof JournalAction)[keyof typeof JournalAction];

export interface RemovedEpic {
  readonly title: string;
  readonly notes: string;
}

export interface EntryChanges {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly removedEpics?: readonly RemovedEpic[];
}

export interface JournalRecord extends EntryChanges {
  readonly at: string;
  readonly writer: string;
  readonly action: JournalActionName;
  readonly version: string;
  readonly archived?: readonly string[];
}

export function isTheLordsName(name: string): boolean {
  return name.toLowerCase() === LORD_WRITER.toLowerCase();
}

export function journalPathIn(dataHome: string): string {
  return path.join(dataHome, JOURNAL_FILE_NAME);
}

export function journaledPagePathIn(dataHome: string): string {
  return path.join(dataHome, JOURNALED_PAGE_FILE_NAME);
}

function isAnEpic(entry: PageEntry): boolean {
  return entry.section === PageSection.Epics;
}

function journalNameOf(entry: PageEntry): string {
  return isAnEpic(entry) ? `${PageSection.Epics}: ${entry.identity}` : entry.identity;
}

function placeAndBodyByJournalName(entries: readonly PageEntry[]): Map<string, string> {
  const placeAndBody = new Map<string, string>();
  for (const entry of entries) {
    const name = journalNameOf(entry);
    placeAndBody.set(name, `${placeAndBody.get(name) ?? ""}${entry.section}\n${entry.body}\n`);
  }
  return placeAndBody;
}

function removedEpicsAmong(entriesBefore: readonly PageEntry[], removed: readonly string[]): RemovedEpic[] {
  return entriesBefore
    .filter((entry) => isAnEpic(entry) && removed.includes(journalNameOf(entry)))
    .map((entry) => ({ title: entry.identity, notes: entry.body.trim() }));
}

export function entryChangesBetween(contentBefore: string, contentAfter: string): EntryChanges {
  const entriesBefore = listEntriesAndEpics(contentBefore);
  const before = placeAndBodyByJournalName(entriesBefore);
  const after = placeAndBodyByJournalName(listEntriesAndEpics(contentAfter));
  const namesAfter = [...after.keys()];
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const removedEpics = removedEpicsAmong(entriesBefore, removed);
  return {
    added: namesAfter.filter((name) => !before.has(name)),
    changed: namesAfter.filter((name) => before.has(name) && before.get(name) !== after.get(name)),
    removed,
    ...(removedEpics.length > 0 ? { removedEpics } : {}),
  };
}

export async function appendJournalLine(dataHome: string, record: JournalRecord): Promise<void> {
  await appendFile(journalPathIn(dataHome), `${JSON.stringify(record)}\n`, "utf8");
}

export async function readJournal(dataHome: string): Promise<JournalRecord[]> {
  const journal = (await readTextFileIfPresent(journalPathIn(dataHome))) ?? "";
  return journal
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as JournalRecord);
}
