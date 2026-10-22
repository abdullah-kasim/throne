import { appendFile } from "node:fs/promises";
import path from "node:path";
import { readTextFileIfPresent } from "./file-presence.ts";
import { listEntries } from "./page-frame.ts";

export const JOURNAL_FILE_NAME = "where-i-stand.journal.jsonl";

export const JOURNALED_PAGE_FILE_NAME = "where-i-stand.journaled.md";
export const UNRECORDED_WRITER = "unknown";
export const LORD_WRITER = "Lord";

export const JournalAction = {
  Write: "write",
  Note: "note",
  Edit: "edit",
  UnrecordedEdit: "unrecorded-edit",
} as const;

export type JournalActionName = (typeof JournalAction)[keyof typeof JournalAction];

export interface EntryChanges {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

export interface JournalRecord extends EntryChanges {
  readonly at: string;
  readonly writer: string;
  readonly action: JournalActionName;
  readonly version: string;
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

function placeAndBodyByIdentity(content: string): Map<string, string> {
  const placeAndBody = new Map<string, string>();
  for (const entry of listEntries(content)) {
    placeAndBody.set(
      entry.identity,
      `${placeAndBody.get(entry.identity) ?? ""}${entry.section}\n${entry.body}\n`,
    );
  }
  return placeAndBody;
}

export function entryChangesBetween(contentBefore: string, contentAfter: string): EntryChanges {
  const before = placeAndBodyByIdentity(contentBefore);
  const after = placeAndBodyByIdentity(contentAfter);
  const identitiesAfter = [...after.keys()];
  return {
    added: identitiesAfter.filter((identity) => !before.has(identity)),
    changed: identitiesAfter.filter(
      (identity) => before.has(identity) && before.get(identity) !== after.get(identity),
    ),
    removed: [...before.keys()].filter((identity) => !after.has(identity)),
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
