import type { StoredPage, StoredRow, StoredSection, StoredTab, StructureListing } from "../web-api-contract/where-i-stand.ts";

const MINUTES_OF_AN_EXACT_TIME = 16;

export function exactTime(storedTime: string): string {
  return `${storedTime.slice(0, MINUTES_OF_AN_EXACT_TIME).replace("T", " ")} UTC`;
}

function authorshipLine(item: StoredTab | StoredSection | StoredRow): string {
  const written = `written ${exactTime(item.writtenAt)} by ${item.writtenBy}`;
  const changed = item.changedAt === item.writtenAt ? "" : `, changed ${exactTime(item.changedAt)} by ${item.changedBy}`;
  const archived = item.archivedAt === null ? "" : `, archived ${exactTime(item.archivedAt)} by ${item.archivedBy}`;
  return `${written}${changed}${archived}`;
}

function sectionsUnder(sections: readonly StoredSection[], tabId: string, parentId: string | null): StoredSection[] {
  return sections.filter((section) => section.tabId === tabId && section.parentId === parentId);
}

export function renderListing(listing: StructureListing): string {
  const lines = [`listing token: ${listing.listingToken}`];
  const archivedMark = (item: StoredTab | StoredSection) => (item.archivedAt === null ? "" : " [archived]");
  const addSections = (tabId: string, parentId: string | null, depth: number): void => {
    for (const section of sectionsUnder(listing.sections, tabId, parentId)) {
      lines.push(`${"  ".repeat(depth)}${section.id} "${section.name}"${archivedMark(section)} (${authorshipLine(section)})`);
      addSections(tabId, section.id, depth + 1);
    }
  };
  for (const tab of listing.tabs) {
    lines.push(`${tab.id} "${tab.name}"${archivedMark(tab)} (${authorshipLine(tab)})`);
    addSections(tab.id, null, 1);
  }
  return `${lines.join("\n")}\n`;
}

function rowMarkdown(row: StoredRow): string {
  const dates = `- ${row.id}: ${authorshipLine(row)}${row.writtenDateIsEstimate ? " (written date estimated)" : ""}`;
  if (row.kind === "event") return `- ${row.text} (${exactTime(row.writtenAt)}, ${row.id})`;
  if (row.kind === "epic") return [`### ${row.text}`, ...row.freeLines, dates].join("\n");
  return [`### ${row.code}`, `- Links: ${row.links}`, `- Kind: ${row.workKind}`, `- Where it stands: ${row.whereItStands}`, ...row.freeLines, dates].join("\n");
}

function sectionTitle(section: StoredSection, parentTitles: readonly string[]): string {
  return [...parentTitles, section.name].join(" › ");
}

export function renderPageAsMarkdown(page: StoredPage): string {
  const live = <Item extends { archivedAt: string | null }>(items: readonly Item[]) => items.filter((item) => item.archivedAt === null);
  const blocks: string[] = [];
  const addSections = (tabId: string, parentId: string | null, parentTitles: readonly string[]): void => {
    for (const section of live(sectionsUnder(page.listing.sections, tabId, parentId))) {
      const archived = page.archivedRowCounts[section.id] ?? 0;
      const archivedNote = archived === 0 ? "" : `, ${archived} archived`;
      const rows = page.rows.filter((row) => row.sectionId === section.id);
      const separator = rows.every((row) => row.kind === "event") ? "\n" : "\n\n";
      blocks.push(`## ${sectionTitle(section, parentTitles)} (${section.id}${archivedNote})`);
      if (rows.length > 0) blocks.push(rows.map(rowMarkdown).join(separator));
      addSections(tabId, section.id, [...parentTitles, section.name]);
    }
  };
  for (const tab of live(page.listing.tabs)) {
    blocks.push(`# ${tab.name} (${tab.id})`);
    addSections(tab.id, null, []);
  }
  return `${blocks.join("\n\n")}\n`;
}
