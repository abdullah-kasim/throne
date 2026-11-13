import type { StoredRow, StoredSection, StoredTab } from "../web-api-contract/where-i-stand.ts";
import type { ContentRow, SectionRow, TabRow } from "./where-i-stand.schema.ts";

export const IdPrefix = { Tab: "t", Section: "s", Row: "r" } as const;

type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

export function shortId(prefix: IdPrefix, id: number): string {
  return `${prefix}${id}`;
}

export function numberOfShortId(prefix: IdPrefix, shortIdText: string): number | undefined {
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(shortIdText.trim());
  return match === null ? undefined : Number(match[1]);
}

function timeOrNull(time: Date | null): string | null {
  return time === null ? null : time.toISOString();
}

function authorshipToContract(row: TabRow | SectionRow | ContentRow) {
  return {
    writtenAt: row.writtenAt.toISOString(),
    writtenBy: row.writtenBy,
    changedAt: row.changedAt.toISOString(),
    changedBy: row.changedBy,
    archivedAt: timeOrNull(row.archivedAt),
    archivedBy: row.archivedBy,
  };
}

export function tabToContract(row: TabRow): StoredTab {
  return { id: shortId(IdPrefix.Tab, row.id), name: row.name, position: row.position, ...authorshipToContract(row) };
}

export function sectionToContract(row: SectionRow): StoredSection {
  return {
    id: shortId(IdPrefix.Section, row.id),
    tabId: shortId(IdPrefix.Tab, row.tabId),
    parentId: row.parentId === null ? null : shortId(IdPrefix.Section, row.parentId),
    name: row.name,
    position: row.position,
    ...authorshipToContract(row),
  };
}

export function rowToContract(row: ContentRow): StoredRow {
  return {
    id: shortId(IdPrefix.Row, row.id),
    sectionId: shortId(IdPrefix.Section, row.sectionId),
    kind: row.kind,
    code: row.code,
    links: row.links,
    workKind: row.workKind,
    whereItStands: row.whereItStands,
    freeLines: row.freeLines === "" ? [] : row.freeLines.split("\n"),
    text: row.text,
    writtenDateIsEstimate: row.writtenDateIsEstimate,
    position: row.position,
    ...authorshipToContract(row),
  };
}
