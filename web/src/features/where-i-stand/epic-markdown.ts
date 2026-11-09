import { headingTextOf, startsSectionOrEntry } from "@contract/page-entry-lines.ts";
import type { PageEntry } from "@/features/where-i-stand/read-page";

export const EPICS_HEADING_LINE = "## Epics";
const NO_EPIC_TITLE_WORDS = "Not saved: an epic needs a title.";
const REPEATED_EPIC_TITLE_WORDS = "Not saved: that title is already on the page.";
const HEADING_IN_NOTES_WORDS = "Not saved: a notes line starting with ## or ### would start a new section or entry. Use #### or bold text.";

function linesBelowTheHeading(epicMarkdown: string): string[] {
  return epicMarkdown.split("\n").slice(1);
}

function blankLinesBeforeTheNotes(lines: readonly string[]): number {
  const firstNotesLine = lines.findIndex((line) => line.trim() !== "");
  return firstNotesLine === -1 ? lines.length : firstNotesLine;
}

export function headingLineOf(epicMarkdown: string): string {
  return epicMarkdown.split("\n")[0];
}

export function notesOf(epicMarkdown: string): string {
  const lines = linesBelowTheHeading(epicMarkdown);
  return lines.slice(blankLinesBeforeTheNotes(lines)).join("\n");
}

export function epicWithNotes(epicMarkdown: string, notes: string): string {
  const belowTheHeading = linesBelowTheHeading(epicMarkdown);
  const blankLines = belowTheHeading.slice(0, blankLinesBeforeTheNotes(belowTheHeading));
  const lines = [headingLineOf(epicMarkdown), ...blankLines, ...notes.split("\n")];
  while (lines.at(-1)?.trim() === "") lines.pop();
  return lines.join("\n");
}

export function epicsSectionWithNewEpic(title: string, notes: string): string {
  return [EPICS_HEADING_LINE, "", `### ${title}`, ...(notes === "" ? [] : ["", notes])].join("\n");
}

function nthOfHeading(heading: string, occurrence: number): string {
  return occurrence === 1 ? heading : `${heading} (${occurrence})`;
}

function headingOf({ markdown }: PageEntry): string {
  return headingTextOf(headingLineOf(markdown));
}

function freeIdentity(heading: string, taken: ReadonlySet<string>): string {
  let occurrence = 1;
  while (taken.has(nthOfHeading(heading, occurrence))) occurrence += 1;
  return nthOfHeading(heading, occurrence);
}

function epicsSharingHeading(epic: PageEntry, epics: readonly PageEntry[]): PageEntry[] {
  const heading = headingOf(epic);
  return epics.filter((candidate) => headingOf(candidate) === heading);
}

function occurrenceOfHeading(epic: PageEntry, epics: readonly PageEntry[]): number {
  return epicsSharingHeading(epic, epics).indexOf(epic) + 1;
}

export function occurrenceOfRepeatedHeading(epic: PageEntry, epics: readonly PageEntry[]): number | undefined {
  return epicsSharingHeading(epic, epics).length > 1 ? occurrenceOfHeading(epic, epics) : undefined;
}

export function epicNameAmong(epic: PageEntry, epics: readonly PageEntry[]): string {
  return nthOfHeading(headingOf(epic), occurrenceOfHeading(epic, epics));
}

export function epicsToldApart(epicsBefore: readonly PageEntry[], epics: readonly PageEntry[]): PageEntry[] {
  const unclaimed = [...epicsBefore];
  function claimIdentity(isSameEpic: (epicBefore: PageEntry) => boolean): string | undefined {
    const position = unclaimed.findIndex(isSameEpic);
    return position === -1 ? undefined : unclaimed.splice(position, 1)[0].identity;
  }
  const inTheSamePlace = epics.map(({ markdown }, position) => claimIdentity((epicBefore) => epicBefore === epicsBefore[position] && epicBefore.markdown === markdown));
  const withTheSameText = epics.map(({ markdown }, position) => inTheSamePlace[position] ?? claimIdentity((epicBefore) => epicBefore.markdown === markdown));
  const taken = new Set(withTheSameText.filter((identity) => identity !== undefined));
  return epics.map((epic, position) => {
    const identity = withTheSameText[position] ?? freeIdentity(epic.identity, taken);
    taken.add(identity);
    return { ...epic, identity };
  });
}

export function notesRefusal(notes: string): string | null {
  return notes.split("\n").some(startsSectionOrEntry) ? HEADING_IN_NOTES_WORDS : null;
}

export function addEpicRefusal(title: string, notes: string, entriesOnThePage: readonly PageEntry[]): string | null {
  if (title === "") return NO_EPIC_TITLE_WORDS;
  if (entriesOnThePage.some(({ identity }) => identity === title)) return REPEATED_EPIC_TITLE_WORDS;
  return notesRefusal(notes);
}
