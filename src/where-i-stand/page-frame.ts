import { createHash } from "node:crypto";

export const PageSection = {
  JustHappened: "Just happened",
  NeedsYou: "Needs you",
  InFlight: "In flight",
  QueuedAndDeferred: "Queued and deferred",
  DeliveredNotOnGitHub: "Delivered, not on GitHub",
  OnGitHub: "On GitHub",
} as const;

export const FRAME_SECTIONS: readonly string[] = [
  PageSection.JustHappened,
  PageSection.NeedsYou,
  PageSection.InFlight,
  PageSection.QueuedAndDeferred,
  PageSection.DeliveredNotOnGitHub,
  PageSection.OnGitHub,
];

const SECTIONS_HOLDING_ENTRIES: readonly string[] = [
  PageSection.InFlight,
  PageSection.QueuedAndDeferred,
  PageSection.DeliveredNotOnGitHub,
  PageSection.OnGitHub,
];

const SECTIONS_HOLDING_ENTRIES_AND_QUESTIONS: readonly string[] = [PageSection.NeedsYou, ...SECTIONS_HOLDING_ENTRIES];

const SECTION_HEADING_PREFIX = "## ";
const ENTRY_HEADING_PREFIX = "### ";
const EVENT_LINE_PREFIX = "- ";
export const NEWEST_EVENTS_KEPT = 15;

export function sectionHeadingOf(section: string): string {
  return `${SECTION_HEADING_PREFIX}${section}`;
}

export function entryHeadingOf(identity: string): string {
  return `${ENTRY_HEADING_PREFIX}${identity}`;
}

export const FRAME_HEADINGS: readonly string[] = FRAME_SECTIONS.map(sectionHeadingOf);

export const EMPTY_FRAME = FRAME_HEADINGS.map((heading) => `${heading}\n`).join("\n");

export function versionOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sectionNamedBy(line: string): string | undefined {
  return line.startsWith(SECTION_HEADING_PREFIX)
    ? line.slice(SECTION_HEADING_PREFIX.length).trim()
    : undefined;
}

function sectionsNamedIn(content: string): string[] {
  return content
    .split("\n")
    .map(sectionNamedBy)
    .filter((section) => section !== undefined);
}

function isFrameSection(section: string): boolean {
  return FRAME_SECTIONS.includes(section);
}

function quotedHeadingsOf(sections: readonly string[]): string {
  return sections.map((section) => `"${sectionHeadingOf(section)}"`).join(", ");
}

export function frameFaultsOf(content: string): string[] {
  const found = sectionsNamedIn(content);
  const faults: string[] = [];
  for (const section of FRAME_SECTIONS) {
    const timesFound = found.filter((name) => name === section).length;
    if (timesFound === 0) faults.push(`the heading "${sectionHeadingOf(section)}" is missing`);
    if (timesFound > 1) faults.push(`the heading "${sectionHeadingOf(section)}" appears ${timesFound} times`);
  }
  for (const section of new Set(found.filter((name) => !isFrameSection(name)))) {
    faults.push(`the heading "${sectionHeadingOf(section)}" is not a section of the page`);
  }
  const foundOrder = [...new Set(found.filter(isFrameSection))];
  const neededOrder = FRAME_SECTIONS.filter((section) => foundOrder.includes(section));
  if (foundOrder.join("\n") !== neededOrder.join("\n")) {
    faults.push(
      `the headings are out of order: found ${quotedHeadingsOf(foundOrder)}, the page needs ${quotedHeadingsOf(neededOrder)}`,
    );
  }
  return faults;
}

export interface PageEntry {
  readonly identity: string;
  readonly section: string;
  readonly body: string;
}

interface EntryBeingRead {
  readonly identity: string;
  readonly section: string;
  readonly bodyLines: string[];
}

function entriesInSections(content: string, sectionsRead: readonly string[]): PageEntry[] {
  const isRead = (section: string | undefined): section is string => section !== undefined && sectionsRead.includes(section);
  const entries: EntryBeingRead[] = [];
  let section: string | undefined;
  let entryBeingRead: EntryBeingRead | undefined;
  for (const line of content.split("\n")) {
    const namedSection = sectionNamedBy(line);
    if (namedSection !== undefined) {
      section = namedSection;
      entryBeingRead = undefined;
    } else if (line.startsWith(ENTRY_HEADING_PREFIX) && isRead(section)) {
      entryBeingRead = { identity: line.slice(ENTRY_HEADING_PREFIX.length).trim(), section, bodyLines: [] };
      entries.push(entryBeingRead);
    } else {
      entryBeingRead?.bodyLines.push(line);
    }
  }
  return entries.map((entry) => ({
    identity: entry.identity,
    section: entry.section,
    body: entry.bodyLines.join("\n"),
  }));
}

export function listEntries(content: string): PageEntry[] {
  return entriesInSections(content, SECTIONS_HOLDING_ENTRIES);
}

export function listEntriesAndQuestions(content: string): PageEntry[] {
  return entriesInSections(content, SECTIONS_HOLDING_ENTRIES_AND_QUESTIONS);
}

function isEventLine(line: string): boolean {
  return line.startsWith(EVENT_LINE_PREFIX);
}

function withEventLineOnTop(sectionLines: readonly string[], eventLine: string): string[] {
  const firstEvent = sectionLines.findIndex(isEventLine);
  if (firstEvent !== -1) {
    return [...sectionLines.slice(0, firstEvent), eventLine, ...sectionLines.slice(firstEvent)];
  }
  const afterLeadingBlankLine = sectionLines[0] === "" ? 1 : 0;
  return [
    ...sectionLines.slice(0, afterLeadingBlankLine),
    eventLine,
    "",
    ...sectionLines.slice(afterLeadingBlankLine),
  ];
}

function newestEventsOnly(sectionLines: readonly string[]): string[] {
  let eventsSeen = 0;
  return sectionLines.filter((line) => !isEventLine(line) || ++eventsSeen <= NEWEST_EVENTS_KEPT);
}

export function withEventOnTop(framedContent: string, event: string): string {
  const lines = framedContent.split("\n");
  const firstLine = lines.findIndex((line) => sectionNamedBy(line) === PageSection.JustHappened) + 1;
  const nextHeading = lines.findIndex(
    (line, index) => index >= firstLine && sectionNamedBy(line) !== undefined,
  );
  const sectionLines = newestEventsOnly(
    withEventLineOnTop(lines.slice(firstLine, nextHeading), `${EVENT_LINE_PREFIX}${event}`),
  );
  return [...lines.slice(0, firstLine), ...sectionLines, ...lines.slice(nextHeading)].join("\n");
}
