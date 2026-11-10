import { ENTRY_HEADING_LEVEL, headingLevelOf, headingTextOf } from "../web-api-contract/page-entry-lines.ts";
import { EditLockOutcome, releaseEditLock, takeEditLock, type ReleasedEditLock } from "./edit-lock.ts";
import { entryHeadingOf, frameFaultsOf, PageSection, sectionHeadingOf, sectionNamedBy } from "./page-frame.ts";
import { replacePageContent, showPage, type PageWriter } from "./page-store.ts";
import type { UnrecordedEdit } from "./unrecorded-edit.ts";

export const SECTIONS_PUT_ACCEPTS: readonly string[] = [
  PageSection.NeedsYou,
  PageSection.InFlight,
  PageSection.QueuedAndDeferred,
  PageSection.DeliveredNotOnGitHub,
  PageSection.OnGitHub,
];

export const ENTRY_OPENING_LINES = ["- Links:", "- Kind:", "- Where it stands:"] as const;

export type PutRequest =
  | { readonly code: string; readonly section: string; readonly text: string }
  | { readonly code: string; readonly remove: true };

export const PutOutcome = {
  Written: "written",
  Unchanged: "unchanged",
  EpicsRefused: "epics-refused",
  UnknownSection: "unknown-section",
  OpeningLineMissing: "opening-line-missing",
  FrameBroken: "frame-broken",
  HeldByAnother: "held-by-another",
  PageChanged: "page-changed",
} as const;

export type PutAttempt = (
  | { readonly outcome: typeof PutOutcome.Written; readonly released: ReleasedEditLock }
  | { readonly outcome: typeof PutOutcome.Unchanged; readonly checksum: string }
  | { readonly outcome: typeof PutOutcome.EpicsRefused }
  | { readonly outcome: typeof PutOutcome.UnknownSection; readonly section: string }
  | { readonly outcome: typeof PutOutcome.OpeningLineMissing; readonly line: string }
  | { readonly outcome: typeof PutOutcome.FrameBroken; readonly faults: readonly string[] }
  | { readonly outcome: typeof PutOutcome.HeldByAnother; readonly holder: string }
  | { readonly outcome: typeof PutOutcome.PageChanged }
) & { readonly unrecordedEdit?: UnrecordedEdit };

function bodyLinesOf(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const first = lines.findIndex((line) => line !== "");
  const last = lines.findLastIndex((line) => line !== "");
  return first === -1 ? [] : lines.slice(first, last + 1);
}

function missingOpeningLine(bodyLines: readonly string[]): string | undefined {
  return ENTRY_OPENING_LINES.find((opening, position) => bodyLines[position]?.startsWith(opening) !== true);
}

function isEntryHeadingFor(line: string, code: string): boolean {
  return headingLevelOf(line) === ENTRY_HEADING_LEVEL && headingTextOf(line) === code;
}

export function withoutEntriesHeaded(page: string, code: string): string {
  const kept: string[] = [];
  let section: string | undefined;
  let skipping = false;
  for (const line of page.split("\n")) {
    const namedSection = sectionNamedBy(line);
    if (namedSection !== undefined) section = namedSection;
    if (namedSection !== undefined || headingLevelOf(line) === ENTRY_HEADING_LEVEL) {
      skipping = section !== undefined && SECTIONS_PUT_ACCEPTS.includes(section) && isEntryHeadingFor(line, code);
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

function withEntryOnTop(page: string, section: string, code: string, bodyLines: readonly string[]): string {
  const lines = page.split("\n");
  const heading = lines.indexOf(sectionHeadingOf(section));
  const next = lines[heading + 1];
  const closing = next === "" || next === undefined ? [] : [""];
  return lines.toSpliced(heading + 1, 0, "", entryHeadingOf(code), "", ...bodyLines, ...closing).join("\n");
}

function refusalOfRequest(request: PutRequest): PutAttempt | undefined {
  if ("remove" in request) return undefined;
  if (request.section === PageSection.Epics) return { outcome: PutOutcome.EpicsRefused };
  if (!SECTIONS_PUT_ACCEPTS.includes(request.section)) return { outcome: PutOutcome.UnknownSection, section: request.section };
  const line = missingOpeningLine(bodyLinesOf(request.text));
  return line === undefined ? undefined : { outcome: PutOutcome.OpeningLineMissing, line };
}

function pageAfter(page: string, request: PutRequest): string {
  const without = withoutEntriesHeaded(page, request.code);
  return "remove" in request ? without : withEntryOnTop(without, request.section, request.code, bodyLinesOf(request.text));
}

export async function putEntry(writer: PageWriter, request: PutRequest): Promise<PutAttempt> {
  const refused = refusalOfRequest(request);
  if (refused !== undefined) return refused;
  const shown = await showPage(writer.dataHome);
  const attempt = await takeEditLock(writer, shown.version, writer.now());
  if (attempt.outcome === EditLockOutcome.HeldByAnother) return { outcome: PutOutcome.HeldByAnother, holder: attempt.holder };
  if (attempt.outcome === EditLockOutcome.StaleChecksum) return { outcome: PutOutcome.PageChanged, unrecordedEdit: attempt.unrecordedEdit };
  const put = pageAfter(attempt.lockTimeContent, request);
  const faults = frameFaultsOf(put);
  if (faults.length > 0) {
    await attempt.lock.release();
    return { outcome: PutOutcome.FrameBroken, faults, unrecordedEdit: attempt.unrecordedEdit };
  }
  let released: ReleasedEditLock;
  try {
    if (put !== attempt.lockTimeContent) await replacePageContent(writer.dataHome, put);
  } finally {
    released = await releaseEditLock(writer, attempt);
  }
  if (released.edit === undefined) {
    return { outcome: PutOutcome.Unchanged, checksum: (await showPage(writer.dataHome)).version, unrecordedEdit: attempt.unrecordedEdit };
  }
  return { outcome: PutOutcome.Written, released, unrecordedEdit: attempt.unrecordedEdit };
}
