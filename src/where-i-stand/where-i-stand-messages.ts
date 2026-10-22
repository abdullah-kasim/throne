import { FRAME_HEADINGS, type PageEntry } from "./page-frame.ts";
import type { EntryChanges } from "./page-journal.ts";
import type { ReleasedEditLock } from "./edit-lock.ts";
import type { UnrecordedEdit } from "./unrecorded-edit.ts";
import { SaveOutcome, type SaveAttempt } from "./page-save.ts";
import { stillSays } from "./same-work-entries.ts";

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

function renderBrokenFrameAtRelease(released: ReleasedEditLock): string {
  return (
    `where-i-stand: the page does not keep its frame: ${released.frameFaults.join("; ")}. ` +
    `The page holds exactly these headings, each once, in this order: ${FRAME_HEADINGS.join(", ")}. ` +
    `The page was left as it is; the copy saved when the lock was taken is ${released.savedCopy}. ` +
    "Lock again and fix the frame.\n"
  );
}

function renderSameWork(groups: readonly (readonly PageEntry[])[]): string {
  return (
    `These entries are about the same work: ${groups.map((group) => group.map(stillSays).join(" and ")).join("; ")}. ` +
    "Keep one current entry per piece of work: remove each older entry, or correct its line and add one line " +
    "``Superseded by `### <identity>` on <date>`` naming the entry that now holds the truth."
  );
}

function renderSameWorkAtRelease(released: ReleasedEditLock): string {
  return `where-i-stand: ${renderSameWork(released.sameWorkGroups)} The page was left as it is. Lock again and fix it.\n`;
}

export function renderFaultsAtRelease(released: ReleasedEditLock): string {
  return [
    ...(released.frameFaults.length > 0 ? [renderBrokenFrameAtRelease(released)] : []),
    ...(released.sameWorkGroups.length > 0 ? [renderSameWorkAtRelease(released)] : []),
  ].join("");
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

export function renderNameReservedForTheLord(name: string): string {
  return `${NOTHING_WAS_WRITTEN} The writer name "${name}" belongs to the Lord's own saves from the page, so no agent may lock or note the page under it.\n`;
}

const SAVED_ANSWER = "Saved; the page now holds your change.";

export const SAVE_INPUT_REFUSED =
  "Not saved: the save needs one JSON object holding the entry as the page loaded it and its new text.";

export function renderSaveAnswer(attempt: SaveAttempt): string {
  switch (attempt.outcome) {
    case SaveOutcome.Saved:
      return attempt.sameWorkGroups.length === 0
        ? SAVED_ANSWER
        : `${SAVED_ANSWER} ${renderSameWork(attempt.sameWorkGroups)}`;
    case SaveOutcome.Unchanged:
      return "Nothing to save; the entry is as it was.";
    case SaveOutcome.EntryChanged:
      return "Not saved: this entry changed since the page loaded, and nothing was overwritten.";
    case SaveOutcome.LockHeld:
      return `Not saved: the page's edit lock is held by ${attempt.holder}; save again once it is released.`;
    case SaveOutcome.FrameBroken:
      return `Not saved: the page would no longer keep its frame (${attempt.faults.join("; ")}).`;
    case SaveOutcome.Failed:
      return `Not saved: ${attempt.reason}.`;
  }
}
