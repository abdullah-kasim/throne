import { ENTRY_HEADING_LEVEL, entryEnd, headingLevelOf, headingTextOf } from "../web-api-contract/page-entry-lines.ts";
import { EditLockOutcome, releaseEditLock, takeEditLock, type ReleasedEditLock } from "./edit-lock.ts";
import { changesOnlyTheEpics, epicsHeadingPositionIn, frameFaultsOf } from "./page-frame.ts";
import { LORD_WRITER } from "./page-journal.ts";
import { replacePageContent, showPage, type PageWriter } from "./page-store.ts";
import type { UnrecordedEdit } from "./unrecorded-edit.ts";

export const SaveOutcome = {
  Saved: "saved",
  Unchanged: "unchanged",
  EntryChanged: "entry-changed",
  EntryRepeated: "entry-repeated",
  LockHeld: "lock-held",
  FrameBroken: "frame-broken",
  OutsideEpics: "outside-epics",
  Failed: "failed",
} as const;

export interface UnitChange {
  readonly loaded: string;
  readonly edited: string;
  readonly headingOccurrence?: number;
}

export type SaveAttempt = (
  | { readonly outcome: typeof SaveOutcome.Saved; readonly sameWorkGroups: ReleasedEditLock["sameWorkGroups"] }
  | { readonly outcome: typeof SaveOutcome.Unchanged }
  | { readonly outcome: typeof SaveOutcome.EntryChanged }
  | { readonly outcome: typeof SaveOutcome.EntryRepeated }
  | { readonly outcome: typeof SaveOutcome.LockHeld; readonly holder: string }
  | { readonly outcome: typeof SaveOutcome.FrameBroken; readonly faults: readonly string[] }
  | { readonly outcome: typeof SaveOutcome.OutsideEpics }
  | { readonly outcome: typeof SaveOutcome.Failed; readonly reason: string }
) & { readonly unrecordedEdit?: UnrecordedEdit };

const REMOVED = "";

function linesOf(text: string): string[] {
  return text.split("\n");
}

function unitIsAt(pageLines: readonly string[], unitLines: readonly string[], start: number): boolean {
  return unitLines.every((line, offset) => pageLines[start + offset] === line);
}

function unitFillsEntryAt(pageLines: readonly string[], unitLines: readonly string[], start: number): boolean {
  return entryEnd(pageLines, start) === start + unitLines.length;
}

function startsOfUnitOnPage(pageLines: readonly string[], unitLines: readonly string[]): number[] {
  const starts: number[] = [];
  for (let start = 0; start + unitLines.length <= pageLines.length; start += 1) {
    if (unitIsAt(pageLines, unitLines, start)) starts.push(start);
  }
  return starts;
}

function startsOfChange(pageLines: readonly string[], { loaded, headingOccurrence }: UnitChange): number[] {
  const unitLines = linesOf(loaded);
  const starts = startsOfUnitOnPage(pageLines, unitLines);
  if (headingOccurrence === undefined) return starts;
  const startsOfWholeEntries = starts.filter((start) => unitFillsEntryAt(pageLines, unitLines, start));
  return startsOfWholeEntries.length > 0 ? startsOfWholeEntries : starts;
}

function startsOfEpicsHeaded(pageLines: readonly string[], heading: string): number[] {
  const epicsHeading = epicsHeadingPositionIn(pageLines);
  return pageLines.flatMap((line, position) => (position > epicsHeading && headingLevelOf(line) === ENTRY_HEADING_LEVEL && headingTextOf(line) === heading ? [position] : []));
}

export function entryMeantHasChanged(page: string, { loaded, headingOccurrence }: UnitChange): boolean {
  if (headingOccurrence === undefined) return false;
  const pageLines = linesOf(page);
  const unitLines = linesOf(loaded);
  const start = startsOfEpicsHeaded(pageLines, headingTextOf(unitLines[0] ?? ""))[headingOccurrence - 1];
  return start === undefined || !unitIsAt(pageLines, unitLines, start) || !unitFillsEntryAt(pageLines, unitLines, start);
}

function withoutDoubleBlankLineAt(lines: readonly string[], index: number): string[] {
  return lines[index - 1] === "" && lines[index] === "" ? lines.toSpliced(index, 1) : [...lines];
}

export function replaceUnitLines(page: string, change: UnitChange): string | undefined {
  const { loaded, edited } = change;
  const pageLines = linesOf(page);
  const starts = startsOfChange(pageLines, change);
  if (starts.length !== 1) return undefined;
  const [start = 0] = starts;
  const replacement = edited === REMOVED ? [] : linesOf(edited);
  const lines = pageLines.toSpliced(start, linesOf(loaded).length, ...replacement);
  return (edited === REMOVED ? withoutDoubleBlankLineAt(lines, start) : lines).join("\n");
}

export function unitIsRepeated(page: string, change: UnitChange): boolean {
  return !entryMeantHasChanged(page, change) && startsOfChange(linesOf(page), change).length > 1;
}

export function removalLeavesLinesBehind(page: string, change: UnitChange): boolean {
  if (change.edited !== REMOVED) return false;
  const pageLines = linesOf(page);
  const [start = 0] = startsOfChange(pageLines, change);
  return !unitFillsEntryAt(pageLines, linesOf(change.loaded), start);
}

export function unitChangeOf(input: string): UnitChange | undefined {
  try {
    const parsed = JSON.parse(input) as Partial<Record<keyof UnitChange, unknown>> | null;
    const { loaded, edited } = parsed ?? {};
    return typeof loaded === "string" && loaded !== "" && typeof edited === "string" ? { loaded, edited } : undefined;
  } catch {
    return undefined;
  }
}

export async function saveOneUnitAsTheLord(page: Omit<PageWriter, "name">, change: UnitChange): Promise<SaveAttempt> {
  if (change.edited === change.loaded) return { outcome: SaveOutcome.Unchanged };
  const shown = await showPage(page.dataHome);
  const saved = replaceUnitLines(shown.content, change);
  if (saved === undefined) return { outcome: unitIsRepeated(shown.content, change) ? SaveOutcome.EntryRepeated : SaveOutcome.EntryChanged };
  const faults = frameFaultsOf(saved);
  if (faults.length > 0) return { outcome: SaveOutcome.FrameBroken, faults };
  if (!changesOnlyTheEpics(shown.content, saved)) return { outcome: SaveOutcome.OutsideEpics };
  if (removalLeavesLinesBehind(shown.content, change) || entryMeantHasChanged(shown.content, change)) return { outcome: SaveOutcome.EntryChanged };
  const writer: PageWriter = { ...page, name: LORD_WRITER };
  const attempt = await takeEditLock(writer, shown.version, writer.now());
  if (attempt.outcome === EditLockOutcome.HeldByAnother) return { outcome: SaveOutcome.LockHeld, holder: attempt.holder };
  if (attempt.outcome === EditLockOutcome.StaleChecksum) {
    return { outcome: SaveOutcome.Failed, reason: "the page changed while it was being saved", unrecordedEdit: attempt.unrecordedEdit };
  }
  let released: ReleasedEditLock;
  try {
    await replacePageContent(page.dataHome, saved);
  } finally {
    released = await releaseEditLock(writer, attempt);
  }
  return { outcome: SaveOutcome.Saved, sameWorkGroups: released.sameWorkGroups, unrecordedEdit: attempt.unrecordedEdit };
}
