import { copyFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { withExclusiveFileLock } from "../shared-policy/exclusive-file-lock.ts";
import { replaceFileAtomically } from "../shared-policy/replace-file-atomically.ts";
import { fileIsMissing, readTextFileIfPresent } from "./file-presence.ts";
import { archiveWith, trimPage, type ArchivedEntry } from "./page-trim.ts";
import {
  EMPTY_FRAME,
  frameFaultsOf,
  pageOnlyLacksEpicsSection,
  versionOf,
  withEpicsSection,
  withEventOnTop,
} from "./page-frame.ts";
import {
  appendJournalLine,
  entryChangesBetween,
  FRAME_WRITER,
  journaledPagePathIn,
  JournalAction,
  type JournalActionName,
  type JournalRecord,
} from "./page-journal.ts";

export const PAGE_FILE_NAME = "where-i-stand.md";
export const ARCHIVE_FILE_NAME = "where-i-stand.archive.md";
export const PREVIOUS_COPIES_KEPT = 5;
const PAGE_LOCK_FILE_NAME = "where-i-stand.lock";
const PAGE_LOCK_NAME = "where-i-stand page";
const NEWEST_PREVIOUS_COPY = 1;

export function pagePathIn(dataHome: string): string {
  return path.join(dataHome, PAGE_FILE_NAME);
}

export function archivePathIn(dataHome: string): string {
  return path.join(dataHome, ARCHIVE_FILE_NAME);
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

export async function pageFileLacksEpicsSection(dataHome: string): Promise<boolean> {
  const content = await readTextFileIfPresent(pagePathIn(dataHome));
  return content !== undefined && pageOnlyLacksEpicsSection(content);
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

export async function replacePageContent(dataHome: string, content: string): Promise<void> {
  await replaceFileAtomically(pagePathIn(dataHome), content);
}

export async function writeArchivedEntries(dataHome: string, archived: readonly ArchivedEntry[]): Promise<void> {
  if (archived.length === 0) return;
  const archive = (await readTextFileIfPresent(archivePathIn(dataHome))) ?? "";
  await replaceFileAtomically(archivePathIn(dataHome), archiveWith(archive, archived));
}

export async function trimmedIntoArchive(dataHome: string, content: string, now: Date): Promise<{ page: string; archived: string[] }> {
  const trimmed = trimPage(content, now);
  await writeArchivedEntries(dataHome, trimmed.archived);
  return { page: trimmed.page, archived: trimmed.archived.map((entry) => entry.identity) };
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
  archived: readonly string[] = [],
): Promise<JournalRecord> {
  const record = {
    ...header,
    version: versionOf(contentAfter),
    ...entryChangesBetween(contentBefore, contentAfter),
    ...(archived.length > 0 ? { archived } : {}),
  };
  await replaceFileAtomically(journaledPagePathIn(dataHome), contentAfter);
  await appendJournalLine(dataHome, record);
  return record;
}

export async function addEventToLockedPage(writer: PageWriter, event: string): Promise<PageWriteResult> {
  const current = await showPage(writer.dataHome);
  const faults = frameFaultsOf(current.content);
  if (faults.length > 0) return { outcome: PageWriteOutcome.FrameBroken, faults };
  await keepPreviousCopy(writer.dataHome);
  const next = await trimmedIntoArchive(writer.dataHome, withEventOnTop(current.content, event), writer.now());
  await replacePageContent(writer.dataHome, next.page);
  const record = await recordInJournal(
    writer.dataHome,
    { at: writer.now().toISOString(), writer: writer.name, action: JournalAction.Note },
    current.content,
    next.page,
    next.archived,
  );
  return { outcome: PageWriteOutcome.Written, version: record.version };
}

export async function addEpicsSectionToLockedPage(page: Omit<PageWriter, "name">): Promise<void> {
  if (!(await pageFileLacksEpicsSection(page.dataHome))) return;
  const current = await showPage(page.dataHome);
  const next = withEpicsSection(current.content);
  await keepPreviousCopy(page.dataHome);
  await replacePageContent(page.dataHome, next);
  await recordInJournal(
    page.dataHome,
    { at: page.now().toISOString(), writer: FRAME_WRITER, action: JournalAction.Edit },
    current.content,
    next,
  );
}
