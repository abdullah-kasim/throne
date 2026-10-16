import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tryExclusiveFileLock, type HeldFileLock } from "../shared-policy/exclusive-file-lock.ts";
import { readTextFileIfPresent } from "./file-presence.ts";
import { frameFaultsOf } from "./page-frame.ts";
import { JournalAction, type JournalRecord } from "./page-journal.ts";
import {
  addEventToLockedPage,
  keepPreviousCopy,
  newestPreviousCopyPathIn,
  recordInJournal,
  showPage,
  withPageLock,
  type PageWriter,
  type PageWriteResult,
} from "./page-store.ts";
import { journalUnrecordedEdit, pageHasAnUnrecordedEdit, type UnrecordedEdit } from "./unrecorded-edit.ts";

const EDIT_LOCK_FILE_NAME = "where-i-stand.edit.lock";
const EDIT_LOCK_NAME = "where-i-stand edit";
export const UNKNOWN_HOLDER = "an unknown holder";

export const EditLockOutcome = {
  HeldByAnother: "held-by-another",
  StaleChecksum: "stale-checksum",
  Taken: "taken",
} as const;

export interface TakenEditLock {
  readonly outcome: typeof EditLockOutcome.Taken;
  readonly holder: string;
  readonly lockTimeContent: string;
  readonly savedCopy: string;
  readonly unrecordedEdit: UnrecordedEdit | undefined;
  readonly lock: HeldFileLock;
}

export type EditLockAttempt =
  | { readonly outcome: typeof EditLockOutcome.HeldByAnother; readonly holder: string }
  | {
      readonly outcome: typeof EditLockOutcome.StaleChecksum;
      readonly currentChecksum: string;
      readonly unrecordedEdit: UnrecordedEdit | undefined;
    }
  | TakenEditLock;

export interface ReleasedEditLock {
  readonly edit: JournalRecord | undefined;
  readonly frameFaults: readonly string[];
  readonly savedCopy: string;
}

export type NoteAttempt =
  | { readonly outcome: typeof EditLockOutcome.HeldByAnother; readonly holder: string }
  | { readonly outcome: typeof EditLockOutcome.Taken; readonly written: PageWriteResult; readonly unrecordedEdit: UnrecordedEdit | undefined };

export function editLockPathIn(dataHome: string): string {
  return path.join(dataHome, EDIT_LOCK_FILE_NAME);
}

function holderLineOf(name: string, until: Date): string {
  return `${name} until ${until.toISOString()}`;
}

async function readHolder(dataHome: string): Promise<string> {
  try {
    const holder = (await readTextFileIfPresent(editLockPathIn(dataHome)))?.trim() ?? "";
    return holder === "" ? UNKNOWN_HOLDER : holder;
  } catch {
    return UNKNOWN_HOLDER;
  }
}

async function recordHolder(dataHome: string, holder: string): Promise<void> {
  await writeFile(editLockPathIn(dataHome), `${holder}\n`, "utf8");
}

async function tryTakeEditLockIn(dataHome: string, flockExecutable: string | undefined): Promise<HeldFileLock | undefined> {
  await mkdir(dataHome, { recursive: true });
  return tryExclusiveFileLock(editLockPathIn(dataHome), EDIT_LOCK_NAME, flockExecutable);
}

export async function takeEditLock(writer: PageWriter, checksum: string, until: Date): Promise<EditLockAttempt> {
  const lock = await tryTakeEditLockIn(writer.dataHome, writer.flockExecutable);
  if (lock === undefined) return { outcome: EditLockOutcome.HeldByAnother, holder: await readHolder(writer.dataHome) };
  try {
    const opened = await withPageLock(
      writer.dataHome,
      async () => {
        const unrecordedEdit = await journalUnrecordedEdit(writer.dataHome, writer.now());
        const page = await showPage(writer.dataHome);
        if (page.version !== checksum) {
          return { outcome: EditLockOutcome.StaleChecksum, currentChecksum: page.version, unrecordedEdit } as const;
        }
        await keepPreviousCopy(writer.dataHome);
        return { outcome: EditLockOutcome.Taken, lockTimeContent: page.content, unrecordedEdit } as const;
      },
      writer.flockExecutable,
    );
    if (opened.outcome === EditLockOutcome.StaleChecksum) {
      await lock.release();
      return opened;
    }
    const holder = holderLineOf(writer.name, until);
    await recordHolder(writer.dataHome, holder);
    return { ...opened, holder, savedCopy: newestPreviousCopyPathIn(writer.dataHome), lock };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export async function releaseEditLock(writer: PageWriter, taken: TakenEditLock): Promise<ReleasedEditLock> {
  try {
    return await withPageLock(
      writer.dataHome,
      async () => {
        const current = await showPage(writer.dataHome);
        const edit =
          current.content === taken.lockTimeContent
            ? undefined
            : await recordInJournal(
                writer.dataHome,
                { at: writer.now().toISOString(), writer: writer.name, action: JournalAction.Edit },
                taken.lockTimeContent,
                current.content,
              );
        return { edit, frameFaults: frameFaultsOf(current.content), savedCopy: taken.savedCopy };
      },
      writer.flockExecutable,
    );
  } finally {
    await taken.lock.release();
  }
}

export async function addEventUnlessAnEditIsHeld(writer: PageWriter, event: string): Promise<NoteAttempt> {
  const lock = await tryTakeEditLockIn(writer.dataHome, writer.flockExecutable);
  if (lock === undefined) return { outcome: EditLockOutcome.HeldByAnother, holder: await readHolder(writer.dataHome) };
  try {
    await recordHolder(writer.dataHome, holderLineOf(writer.name, writer.now()));
    return await withPageLock(
      writer.dataHome,
      async () => {
        const unrecordedEdit = await journalUnrecordedEdit(writer.dataHome, writer.now());
        return { outcome: EditLockOutcome.Taken, written: await addEventToLockedPage(writer, event), unrecordedEdit };
      },
      writer.flockExecutable,
    );
  } finally {
    await lock.release();
  }
}

export async function journalUnrecordedEditUnlessAnEditIsHeld(
  writer: Omit<PageWriter, "name">,
): Promise<UnrecordedEdit | undefined> {
  if (!(await pageHasAnUnrecordedEdit(writer.dataHome))) return undefined;
  const lock = await tryTakeEditLockIn(writer.dataHome, writer.flockExecutable);
  if (lock === undefined) return undefined;
  try {
    return await withPageLock(writer.dataHome, () => journalUnrecordedEdit(writer.dataHome, writer.now()), writer.flockExecutable);
  } finally {
    await lock.release();
  }
}
