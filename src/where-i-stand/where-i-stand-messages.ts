import { FRAME_HEADINGS } from "./page-frame.ts";
import type { EntryChanges } from "./page-journal.ts";
import type { ReleasedEditLock } from "./edit-lock.ts";
import type { UnrecordedEdit } from "./unrecorded-edit.ts";

export const NOTHING_WAS_WRITTEN = "where-i-stand: refused, nothing was written.";
const ONLY_THE_UNRECORDED_EDIT_WAS_JOURNALED =
  "where-i-stand: refused; only the unrecorded edit above was journaled, and the page was not changed.";

function refusalOpening(unrecordedEditWasJournaled: boolean): string {
  return unrecordedEditWasJournaled ? ONLY_THE_UNRECORDED_EDIT_WAS_JOURNALED : NOTHING_WAS_WRITTEN;
}

export const PAGE_EDIT_STEPS = [
  '1. Run "throne where-i-stand show". It prints the page on stdout, and its path and checksum on stderr. Read the page with your own file tool at that path.',
  '2. Run "throne where-i-stand lock --checksum <checksum> --ttl 5m" in the background, with your harness\'s own way to run a command in the background. It prints one line saying who holds the lock and until when, then waits. If it refuses because the page changed or another lock is held, show and read the page again, then lock again.',
  "3. While the lock is held, change your own entry with your harness's edit tool: a targeted replacement of that entry's text, one entry at a time. Never rewrite the whole file.",
  "4. Stop the background lock command to release the lock, and read its output: it journals your edit and names any fault in the page's frame, which you then fix the same way.",
  '5. If the change is news, add one line to Just happened with "throne where-i-stand note "<one line>"".',
].join("\n");

export function renderWriteIsGone(): string {
  return `${NOTHING_WAS_WRITTEN} "throne where-i-stand write" no longer exists. Edit the page in place instead:\n${PAGE_EDIT_STEPS}\n`;
}

function listOf(identities: readonly string[]): string {
  return identities.length === 0 ? "none" : identities.join(", ");
}

function renderEntryChanges(changes: EntryChanges): string {
  return `added ${listOf(changes.added)}; changed ${listOf(changes.changed)}; removed ${listOf(changes.removed)}`;
}

export function renderHeldByAnother(holder: string): string {
  return `${NOTHING_WAS_WRITTEN} The page's edit lock is held by ${holder}. Wait for it to be released, then try again.\n`;
}

export function renderStaleChecksum(currentChecksum: string, unrecordedEditWasJournaled: boolean): string {
  return (
    `${refusalOpening(unrecordedEditWasJournaled)} The page changed since you read it; its checksum is now ${currentChecksum}. ` +
    `Run "throne where-i-stand show", read the page again, and lock with --checksum ${currentChecksum}.\n`
  );
}

export function renderLockHeld(holder: string, pagePath: string): string {
  return `where-i-stand: locked by ${holder}. Edit ${pagePath} with your edit tool, one entry at a time; stop this command to release the lock.\n`;
}

export function renderRelease(released: ReleasedEditLock): string {
  return released.edit === undefined
    ? "where-i-stand: released. The page did not change, so nothing was journaled.\n"
    : `where-i-stand: released. Journaled the edit: ${renderEntryChanges(released.edit)}. checksum: ${released.edit.version}\n`;
}

export function renderBrokenFrameAtRelease(released: ReleasedEditLock): string {
  return (
    `where-i-stand: the page does not keep its frame: ${released.frameFaults.join("; ")}. ` +
    `The page holds exactly these headings, each once, in this order: ${FRAME_HEADINGS.join(", ")}. ` +
    `The page was left as it is; the copy saved when the lock was taken is ${released.savedCopy}. ` +
    "Lock again and fix the frame.\n"
  );
}

export function renderBrokenFrameOnNote(faults: readonly string[], unrecordedEditWasJournaled: boolean): string {
  return (
    `${refusalOpening(unrecordedEditWasJournaled)} The page does not keep its frame: ${faults.join("; ")}. ` +
    `The page holds exactly these headings, each once, in this order: ${FRAME_HEADINGS.join(", ")}.\n`
  );
}

export function renderUnrecordedEdit(unrecordedEdit: UnrecordedEdit, pagePath: string): string {
  const changes = unrecordedEdit.journaledPageWasKept
    ? renderEntryChanges(unrecordedEdit.record)
    : "no copy of the page as last journaled was kept, so the entries it changed could not be listed";
  return (
    `where-i-stand: ${pagePath} was changed with no lock held: its checksum is ${unrecordedEdit.record.version}, ` +
    `but the journal last recorded ${unrecordedEdit.lastJournaledChecksum}. ` +
    `It was journaled with writer "${unrecordedEdit.record.writer}": ${changes}.\n`
  );
}
