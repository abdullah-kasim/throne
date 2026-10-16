import { readTextFileIfPresent } from "./file-presence.ts";
import { versionOf } from "./page-frame.ts";
import {
  journaledPagePathIn,
  JournalAction,
  readJournal,
  UNRECORDED_WRITER,
  type JournalRecord,
} from "./page-journal.ts";
import { recordInJournal, showPage, type Page } from "./page-store.ts";

export interface UnrecordedEdit {
  readonly record: JournalRecord;
  readonly lastJournaledChecksum: string;
  readonly journaledPageWasKept: boolean;
}

function pageIsAsTheJournalLastLeftIt(page: Page, newestRecord: JournalRecord | undefined): boolean {
  return newestRecord === undefined || newestRecord.version === page.version;
}

async function newestJournalRecordIn(dataHome: string): Promise<JournalRecord | undefined> {
  return (await readJournal(dataHome)).at(-1);
}

async function journaledPageMatching(dataHome: string, newestRecord: JournalRecord): Promise<string | undefined> {
  const journaledPage = await readTextFileIfPresent(journaledPagePathIn(dataHome));
  return journaledPage !== undefined && versionOf(journaledPage) === newestRecord.version ? journaledPage : undefined;
}

export async function pageHasAnUnrecordedEdit(dataHome: string): Promise<boolean> {
  return !pageIsAsTheJournalLastLeftIt(await showPage(dataHome), await newestJournalRecordIn(dataHome));
}

export async function journalUnrecordedEdit(dataHome: string, now: Date): Promise<UnrecordedEdit | undefined> {
  const page = await showPage(dataHome);
  const newestRecord = await newestJournalRecordIn(dataHome);
  if (newestRecord === undefined || pageIsAsTheJournalLastLeftIt(page, newestRecord)) return undefined;
  const journaledPage = await journaledPageMatching(dataHome, newestRecord);
  const record = await recordInJournal(
    dataHome,
    { at: now.toISOString(), writer: UNRECORDED_WRITER, action: JournalAction.UnrecordedEdit },
    journaledPage ?? page.content,
    page.content,
  );
  return { record, lastJournaledChecksum: newestRecord.version, journaledPageWasKept: journaledPage !== undefined };
}
