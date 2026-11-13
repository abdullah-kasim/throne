import { ContentKind } from "../where-i-stand-store/where-i-stand.schema.ts";

export const EVENTS_SECTION = "Just happened";
export const EPICS_SECTION = "Epics";

const SECTION_HEADING = /^## (.+)$/;
const ENTRY_HEADING = /^### (.+)$/;
const EVENT_LINE = /^- (.+)$/;
const FIELD_LINES = {
  links: /^- Links: (.*)$/,
  workKind: /^- Kind: (.*)$/,
  whereItStands: /^- Where it stands: (.*)$/,
} as const;
const WRITTEN_LINE = /Written by ([^,\n]+)[^\n]*?(\d{4}-\d{2}-\d{2})/;

export interface MarkdownEntry {
  readonly section: string;
  readonly kind: ContentKind;
  readonly identity: string;
  readonly links?: string;
  readonly workKind?: string;
  readonly whereItStands?: string;
  readonly freeLines: readonly string[];
  readonly writtenBy?: string;
  readonly writtenOn?: Date;
}

interface EntryBeingRead {
  readonly section: string;
  readonly identity: string;
  readonly bodyLines: string[];
}

function withoutBlankEdges(lines: readonly string[]): string[] {
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return [];
  const last = lines.findLastIndex((line) => line.trim() !== "");
  return lines.slice(first, last + 1);
}

function writtenLineOf(lines: readonly string[]): Pick<MarkdownEntry, "writtenBy" | "writtenOn"> {
  const match = lines.map((line) => WRITTEN_LINE.exec(line)).find((found) => found !== null);
  if (match === undefined || match === null) return {};
  const writtenOn = new Date(`${match[2]}T00:00:00Z`);
  return Number.isNaN(writtenOn.getTime()) ? {} : { writtenBy: match[1]!.trim(), writtenOn };
}

function entryOf(read: EntryBeingRead): MarkdownEntry {
  const written = writtenLineOf(read.bodyLines);
  if (read.section === EPICS_SECTION) {
    return { section: read.section, kind: ContentKind.Epic, identity: read.identity, freeLines: withoutBlankEdges(read.bodyLines), ...written };
  }
  const fields: { -readonly [Field in keyof typeof FIELD_LINES]?: string } = {};
  const freeLines: string[] = [];
  for (const line of read.bodyLines) {
    const field = (Object.keys(FIELD_LINES) as (keyof typeof FIELD_LINES)[]).find((name) => fields[name] === undefined && FIELD_LINES[name].test(line));
    if (field === undefined) freeLines.push(line);
    else fields[field] = FIELD_LINES[field].exec(line)![1]!.trim();
  }
  return { section: read.section, kind: ContentKind.Work, identity: read.identity, ...fields, freeLines: withoutBlankEdges(freeLines), ...written };
}

export function readMarkdownPage(markdown: string): MarkdownEntry[] {
  const entries: (MarkdownEntry | EntryBeingRead)[] = [];
  let section: string | undefined;
  let entryBeingRead: EntryBeingRead | undefined;
  for (const line of markdown.split("\n")) {
    const sectionHeading = SECTION_HEADING.exec(line);
    const entryHeading = ENTRY_HEADING.exec(line);
    const eventLine = EVENT_LINE.exec(line);
    if (sectionHeading !== null) {
      section = sectionHeading[1]!.trim();
      entryBeingRead = undefined;
    } else if (section === undefined) {
      continue;
    } else if (entryHeading !== null) {
      entryBeingRead = { section, identity: entryHeading[1]!.trim(), bodyLines: [] };
      entries.push(entryBeingRead);
    } else if (section === EVENTS_SECTION && entryBeingRead === undefined && eventLine !== null) {
      entries.push({ section, kind: ContentKind.Event, identity: eventLine[1]!.trim(), freeLines: [] });
    } else {
      entryBeingRead?.bodyLines.push(line);
    }
  }
  return entries.map((entry) => ("bodyLines" in entry ? entryOf(entry) : entry));
}
