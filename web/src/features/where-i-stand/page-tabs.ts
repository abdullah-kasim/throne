import type { PullRequestRecords, StoredTab } from "@contract/where-i-stand.ts";
import { isNeedsYouEntry, type PageEntry, type PageSection } from "@/features/where-i-stand/read-page";
import { entryNamesRecord } from "@/features/where-i-stand/work-rows";

export const TabName = {
  Now: "now",
  Epics: "epics",
  PullRequests: "pull-requests",
  Archive: "archive",
} as const;

export type TabName = string;

export interface PageTab {
  readonly id: string;
  readonly name: TabName;
  readonly words: string;
}

export function tabNameOf(words: string): TabName {
  return words
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const ARCHIVE_TAB: PageTab = { id: TabName.Archive, name: TabName.Archive, words: "Archive" };

export function pageTabsOf(tabs: readonly StoredTab[]): PageTab[] {
  if (tabs.length === 0) return [];
  return [...tabs.map(({ id, name }) => ({ id, name: tabNameOf(name), words: name })), ARCHIVE_TAB];
}

export type TabCounts = Readonly<Record<TabName, number | undefined>>;

export function tabNameOfSection(section: Pick<PageSection, "tabId">, tabs: readonly PageTab[]): TabName {
  return tabs.find(({ id }) => id === section.tabId)?.name ?? TabName.Now;
}

export function entryIsEpic({ row }: PageEntry): boolean {
  return row.kind === "epic";
}

export function selectedTabNameOf(hash: string, tabs: readonly PageTab[]): TabName {
  const named = hash.slice(1);
  if (tabs.length === 0) return named || TabName.Now;
  return tabs.find(({ name }) => name === named)?.name ?? tabs[0].name;
}

function pullRequestCount(entriesOfTab: readonly PageEntry[], { rows }: PullRequestRecords): number {
  const entriesNamingNoRecord = entriesOfTab.filter((entry) => !rows.some((record) => entryNamesRecord(entry, record)));
  return rows.length + entriesNamingNoRecord.length;
}

function entriesBySection(sections: readonly PageSection[]): { section: PageSection; entries: readonly PageEntry[] }[] {
  const flatten = (section: PageSection): PageEntry[] => [...section.entries, ...section.subsections.flatMap(flatten)];
  return sections.map((section) => ({ section, entries: flatten(section) }));
}

export function tabCounts(tabs: readonly PageTab[], sections: readonly PageSection[], records: PullRequestRecords | undefined): TabCounts {
  const grouped = entriesBySection(sections);
  return Object.fromEntries(
    tabs.map((tab) => {
      const entriesOfTab = grouped.filter(({ section }) => section.tabId === tab.id).flatMap(({ entries }) => entries);
      if (tab === ARCHIVE_TAB) return [tab.name, undefined];
      if (tab.name !== TabName.PullRequests) return [tab.name, entriesOfTab.length];
      return [tab.name, records === undefined ? undefined : pullRequestCount(entriesOfTab, records)];
    }),
  );
}

export function needsYouCountOf(entries: readonly PageEntry[]): number {
  return entries.filter(isNeedsYouEntry).length;
}

export function tabLabel(words: string, count: number, needsYouCount: number): string {
  const needsYouWords = needsYouCount > 0 ? `, ${needsYouCount} needs you` : "";
  return `${words}, ${count} ${count === 1 ? "item" : "items"}${needsYouWords}`;
}

export function selectedTabButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
}

function canTakeFocus(control: HTMLElement): boolean {
  return control.isConnected && !control.matches(":disabled") && control.closest("[hidden]") === null;
}

export function controlOrSelectedTab(control: HTMLElement | undefined): HTMLElement | null {
  return control !== undefined && canTakeFocus(control) ? control : selectedTabButton();
}
