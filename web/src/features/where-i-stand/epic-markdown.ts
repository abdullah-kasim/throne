import type { PageEntry } from "@/features/where-i-stand/read-page";

const NO_EPIC_TITLE_WORDS = "Not saved: an epic needs a title.";
const REPEATED_EPIC_TITLE_WORDS = "Not saved: that title is already on the page.";

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

export function notesLinesOf(notes: string): string[] {
  const lines = notes.split("\n");
  while (lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

export function epicWithNotes(epicMarkdown: string, notes: string): string {
  const belowTheHeading = linesBelowTheHeading(epicMarkdown);
  const blankLines = belowTheHeading.slice(0, blankLinesBeforeTheNotes(belowTheHeading));
  return [headingLineOf(epicMarkdown), ...blankLines, ...notesLinesOf(notes)].join("\n");
}

export function addEpicRefusal(title: string, entriesOnThePage: readonly PageEntry[]): string | null {
  if (title === "") return NO_EPIC_TITLE_WORDS;
  if (entriesOnThePage.some(({ identity }) => identity === title)) return REPEATED_EPIC_TITLE_WORDS;
  return null;
}
