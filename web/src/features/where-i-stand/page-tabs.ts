import type { PullRequestRecords } from "@contract/where-i-stand.ts";
import { isNeedsYouEntry, NEEDS_YOU_HEADING, type PageEntry } from "@/features/where-i-stand/read-page";
import { entryNamesRecord } from "@/features/where-i-stand/work-rows";

const ON_GITHUB_HEADING = "On GitHub";

export const TabName = {
  Now: "now",
  Epics: "epics",
  Queue: "queue",
  Delivered: "delivered",
  PullRequests: "pull-requests",
} as const;

export type TabName = (typeof TabName)[keyof typeof TabName];

export interface PageTab {
  readonly name: TabName;
  readonly words: string;
  readonly sectionHeadings: readonly string[];
}

export const pageTabs: readonly PageTab[] = [
  { name: TabName.Now, words: "Now", sectionHeadings: [NEEDS_YOU_HEADING, "Just happened", "In flight"] },
  { name: TabName.Epics, words: "Epics", sectionHeadings: ["Epics"] },
  { name: TabName.Queue, words: "Queue", sectionHeadings: ["Queued and deferred"] },
  { name: TabName.Delivered, words: "Delivered", sectionHeadings: ["Delivered, not on GitHub"] },
  { name: TabName.PullRequests, words: "Pull requests", sectionHeadings: [ON_GITHUB_HEADING] },
];

export type TabCounts = Readonly<Record<TabName, number | undefined>>;

export function tabNameOfSection(sectionHeading: string): TabName {
  return pageTabs.find(({ sectionHeadings }) => sectionHeadings.includes(sectionHeading))?.name ?? TabName.Now;
}

export function entryIsEpic({ sectionHeading }: PageEntry): boolean {
  return tabNameOfSection(sectionHeading) === TabName.Epics;
}

export function selectedTabNameOf(hash: string): TabName {
  return pageTabs.find(({ name }) => name === hash.slice(1))?.name ?? TabName.Now;
}

function pullRequestCount(entries: readonly PageEntry[], { rows }: PullRequestRecords): number {
  const entriesNamingNoRecord = entries.filter((entry) => entry.sectionHeading === ON_GITHUB_HEADING && !rows.some((record) => entryNamesRecord(entry, record)));
  return rows.length + entriesNamingNoRecord.length;
}

export function tabCounts(entries: readonly PageEntry[], records: PullRequestRecords | undefined): TabCounts {
  const entriesInTab = (tabName: TabName) => entries.filter(({ sectionHeading }) => tabNameOfSection(sectionHeading) === tabName).length;
  return {
    [TabName.Now]: entriesInTab(TabName.Now),
    [TabName.Epics]: entriesInTab(TabName.Epics),
    [TabName.Queue]: entriesInTab(TabName.Queue),
    [TabName.Delivered]: entriesInTab(TabName.Delivered),
    [TabName.PullRequests]: records === undefined ? undefined : pullRequestCount(entries, records),
  };
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
