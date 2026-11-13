import type { StoredPage, StoredRow } from "../web-api-contract/where-i-stand.ts";
import { readMarkdownPage, type MarkdownEntry } from "./markdown-page-reader.ts";

function describedEntry(entry: MarkdownEntry): string {
  return JSON.stringify([entry.kind, entry.identity, entry.links ?? null, entry.workKind ?? null, entry.whereItStands ?? null, entry.freeLines]);
}

function describedRow(row: StoredRow): string {
  return JSON.stringify([row.kind, row.code ?? row.text, row.links, row.workKind, row.whereItStands, row.freeLines]);
}

function grouped<Item>(items: readonly Item[], sectionOf: (item: Item) => string, describe: (item: Item) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const item of items) groups.set(sectionOf(item), [...(groups.get(sectionOf(item)) ?? []), describe(item)]);
  return groups;
}

export function differencesFromMarkdownPage(markdown: string, stored: StoredPage): string[] {
  const sectionNames = new Map(stored.listing.sections.map((section) => [section.id, section.name]));
  const before = grouped(readMarkdownPage(markdown), (entry) => entry.section, describedEntry);
  const after = grouped(stored.rows, (row) => sectionNames.get(row.sectionId) ?? row.sectionId, describedRow);
  const differences: string[] = [];
  for (const section of new Set([...before.keys(), ...after.keys()])) {
    const markdownEntries = before.get(section) ?? [];
    const storedRows = after.get(section) ?? [];
    const length = Math.max(markdownEntries.length, storedRows.length);
    for (let position = 0; position < length; position += 1) {
      if (markdownEntries[position] !== storedRows[position]) {
        differences.push(`${section}, place ${position + 1}: the Markdown page has ${markdownEntries[position] ?? "nothing"}, the database has ${storedRows[position] ?? "nothing"}`);
      }
    }
  }
  return differences;
}
