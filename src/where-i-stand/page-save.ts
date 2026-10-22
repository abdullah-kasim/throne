import { EditLockOutcome, releaseEditLock, takeEditLock, type ReleasedEditLock } from "./edit-lock.ts";
import { frameFaultsOf } from "./page-frame.ts";
import { LORD_WRITER } from "./page-journal.ts";
import { replacePageContent, showPage, type PageWriter } from "./page-store.ts";
import type { UnrecordedEdit } from "./unrecorded-edit.ts";

export const SaveOutcome = {
  Saved: "saved",
  Unchanged: "unchanged",
  EntryChanged: "entry-changed",
  LockHeld: "lock-held",
  FrameBroken: "frame-broken",
  Failed: "failed",
} as const;

export interface UnitChange {
  readonly loaded: string;
  readonly edited: string;
}

export type SaveAttempt = (
  | { readonly outcome: typeof SaveOutcome.Saved; readonly sameWorkGroups: ReleasedEditLock["sameWorkGroups"] }
  | { readonly outcome: typeof SaveOutcome.Unchanged }
  | { readonly outcome: typeof SaveOutcome.EntryChanged }
  | { readonly outcome: typeof SaveOutcome.LockHeld; readonly holder: string }
  | { readonly outcome: typeof SaveOutcome.FrameBroken; readonly faults: readonly string[] }
  | { readonly outcome: typeof SaveOutcome.Failed; readonly reason: string }
) & { readonly unrecordedEdit?: UnrecordedEdit };

const REMOVED = "";

function linesOf(text: string): string[] {
  return text.split("\n");
}

function startsOfUnitOnPage(pageLines: readonly string[], unitLines: readonly string[]): number[] {
  const starts: number[] = [];
  for (let start = 0; start + unitLines.length <= pageLines.length; start += 1) {
    if (unitLines.every((line, offset) => pageLines[start + offset] === line)) starts.push(start);
  }
  return starts;
}

function withoutDoubleBlankLineAt(lines: readonly string[], index: number): string[] {
  return lines[index - 1] === "" && lines[index] === "" ? lines.toSpliced(index, 1) : [...lines];
}

export function replaceUnitLines(page: string, loaded: string, edited: string): string | undefined {
  const pageLines = linesOf(page);
  const unitLines = linesOf(loaded);
  const starts = startsOfUnitOnPage(pageLines, unitLines);
  if (starts.length !== 1) return undefined;
  const [start = 0] = starts;
  const replacement = edited === REMOVED ? [] : linesOf(edited);
  const lines = pageLines.toSpliced(start, unitLines.length, ...replacement);
  return (edited === REMOVED ? withoutDoubleBlankLineAt(lines, start) : lines).join("\n");
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
  const saved = replaceUnitLines(shown.content, change.loaded, change.edited);
  if (saved === undefined) return { outcome: SaveOutcome.EntryChanged };
  const faults = frameFaultsOf(saved);
  if (faults.length > 0) return { outcome: SaveOutcome.FrameBroken, faults };
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
