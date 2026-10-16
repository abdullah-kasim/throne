import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withExclusiveFileLock } from "../shared-policy/exclusive-file-lock.ts";
import { fileIsMissing, readTextFileIfPresent } from "./file-presence.ts";
import { EMPTY_FRAME, frameFaultsOf, versionOf, withEventOnTop } from "./page-frame.ts";
import {
  appendJournalLine,
  entryChangesBetween,
  journaledPagePathIn,
  JournalAction,
  type JournalActionName,
  type JournalRecord,
} from "./page-journal.ts";

export const PAGE_FILE_NAME = "where-i-stand.md";
export const PREVIOUS_COPIES_KEPT = 5;
const PAGE_LOCK_FILE_NAME = "where-i-stand.lock";
const PAGE_LOCK_NAME = "where-i-stand page";
const NEWEST_PREVIOUS_COPY = 1;

export function pagePathIn(dataHome: string): string {
  return path.join(dataHome, PAGE_FILE_NAME);
}

export function previousCopyPathIn(dataHome: string, writesAgo: number): string {
  return path.join(dataHome, `where-i-stand.previous-${writesAgo}.md`);
}

export interface Page {
  readonly content: string;
  readonly version: string;
}

export async function showPage(dataHome: string): Promise<Page> {
  const content = (await readTextFileIfPresent(pagePathIn(dataHome))) ?? EMPTY_FRAME;
  return { content, version: versionOf(content) };
}

export const PageWriteOutcome = {
  Written: "written",
  FrameBroken: "frame-broken",
} as const;

export type PageWriteResult =
  | { readonly outcome: typeof PageWriteOutcome.Written; readonly version: string }
  | { readonly outcome: typeof PageWriteOutcome.FrameBroken; readonly faults: readonly string[] };

export interface PageWriter {
  readonly dataHome: string;
  readonly name: string;
  readonly now: () => Date;
  readonly flockExecutable?: string;
}

export interface JournalRecordHeader {
  readonly at: string;
  readonly writer: string;
  readonly action: JournalActionName;
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!fileIsMissing(error)) throw error;
  }
}

export async function keepPreviousCopy(dataHome: string): Promise<void> {
  for (let writesAgo = PREVIOUS_COPIES_KEPT - 1; writesAgo >= NEWEST_PREVIOUS_COPY; writesAgo -= 1) {
    await renameIfPresent(
      previousCopyPathIn(dataHome, writesAgo),
      previousCopyPathIn(dataHome, writesAgo + 1),
    );
  }
  try {
    await copyFile(pagePathIn(dataHome), previousCopyPathIn(dataHome, NEWEST_PREVIOUS_COPY));
  } catch (error) {
    if (!fileIsMissing(error)) throw error;
  }
}

export function newestPreviousCopyPathIn(dataHome: string): string {
  return previousCopyPathIn(dataHome, NEWEST_PREVIOUS_COPY);
}

async function replaceFileAtomically(file: string, content: string): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, content, "utf8");
    await rename(temporaryFile, file);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

export async function withPageLock<Result>(
  dataHome: string,
  work: () => Promise<Result>,
  flockExecutable?: string,
): Promise<Result> {
  await mkdir(dataHome, { recursive: true });
  return withExclusiveFileLock(path.join(dataHome, PAGE_LOCK_FILE_NAME), PAGE_LOCK_NAME, work, flockExecutable);
}

export async function recordInJournal(
  dataHome: string,
  header: JournalRecordHeader,
  contentBefore: string,
  contentAfter: string,
): Promise<JournalRecord> {
  const record = { ...header, version: versionOf(contentAfter), ...entryChangesBetween(contentBefore, contentAfter) };
  await replaceFileAtomically(journaledPagePathIn(dataHome), contentAfter);
  await appendJournalLine(dataHome, record);
  return record;
}

export async function addEventToLockedPage(writer: PageWriter, event: string): Promise<PageWriteResult> {
  const current = await showPage(writer.dataHome);
  const faults = frameFaultsOf(current.content);
  if (faults.length > 0) return { outcome: PageWriteOutcome.FrameBroken, faults };
  const next = withEventOnTop(current.content, event);
  await keepPreviousCopy(writer.dataHome);
  await replaceFileAtomically(pagePathIn(writer.dataHome), next);
  const record = await recordInJournal(
    writer.dataHome,
    { at: writer.now().toISOString(), writer: writer.name, action: JournalAction.Note },
    current.content,
    next,
  );
  return { outcome: PageWriteOutcome.Written, version: record.version };
}
