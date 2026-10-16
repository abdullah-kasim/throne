import { stat } from "node:fs/promises";
import { completionReportPathForAgent } from "../agentdata/ledger-data.service.ts";
import { DEFAULT_DATA_DIR, readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { isAlpha } from "../amendment/merge-refusal.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { resolveRegentQueueDatabasePath } from "../regent-queue/regent-queue-database.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { nameCarriesObjectiveCode } from "../shared-policy/objective-contract.ts";
import { THRONE_HOME } from "../shared-policy/throne-home.ts";
import { fileIsMissing } from "./file-presence.ts";
import { entryHeadingOf, listEntries, PageSection, sectionHeadingOf, type PageEntry } from "./page-frame.ts";
import { readJournal, type JournalRecord } from "./page-journal.ts";
import { showPage } from "./page-store.ts";
import { entriesAboutTheSameWork, lineToFixIn, readLinksLine, saysItIsSuperseded } from "./same-work-entries.ts";

export interface PageRecordPlaces {
  readonly dataHome: string;
  readonly dataDir: string;
}

export const REAL_PAGE_RECORD_PLACES: PageRecordPlaces = {
  dataHome: THRONE_HOME,
  dataDir: DEFAULT_DATA_DIR,
};

export type PageRecordVerdict =
  | { readonly recorded: true; readonly summary: string }
  | { readonly recorded: false; readonly reason: string };

const PAGE_EDIT_FLOW =
  '"throne where-i-stand show", then "throne where-i-stand lock --checksum <checksum>" run in the background, ' +
  "a targeted edit of that entry with your edit tool, and stopping the lock";
const SECTIONS_FOR_DELIVERED_WORK = [PageSection.DeliveredNotOnGitHub, PageSection.OnGitHub]
  .map((section) => `"${sectionHeadingOf(section)}"`)
  .join(" or ");
const LINKS_LINE_FORMS =
  '`- Links: Forgejo <url or "no Forgejo copy"> · GitHub <url or "not on GitHub yet"> · Ticket <url, id, or "no ticket">`, ' +
  'or `- Links: no pull request · <commit or link> · Ticket <url, id, or "no ticket">` for work with no pull request';

async function objectiveCodeOf(agentName: string, dataDir: string): Promise<string | undefined> {
  const objectiveCode = (await readSpawnSpec(agentName, dataDir))?.objective_code;
  return typeof objectiveCode === "string" && objectiveCode !== "" ? objectiveCode : undefined;
}

function queueRowWasAbandoned(objectiveCode: string, dataDir: string): boolean {
  const store = openRegentQueueStore(resolveRegentQueueDatabasePath(dataDir));
  try {
    return findQueueItemByObjectiveCode(store, objectiveCode)?.status === RegentQueueItemStatus.Abandoned;
  } finally {
    store.close();
  }
}

async function deliveryTimeOf(alphaName: string, dataDir: string): Promise<number | undefined> {
  try {
    return (await stat(completionReportPathForAgent(alphaName, dataDir))).mtimeMs;
  } catch (error) {
    if (fileIsMissing(error)) return undefined;
    throw error;
  }
}

function writerBelongsToCampaign(writer: string, alphaName: string, objectiveCode: string): boolean {
  return sameAgentName(writer, alphaName) || nameCarriesObjectiveCode("shadow", writer, objectiveCode);
}

function namesEntry(record: JournalRecord, identity: string): boolean {
  return record.added.includes(identity) || record.changed.includes(identity);
}

function startsWithLinksLine(entry: PageEntry): boolean {
  return readLinksLine(entry) !== undefined;
}

function lastWriteOf(identity: string, journal: readonly JournalRecord[]): number {
  return Math.max(
    Number.NEGATIVE_INFINITY,
    ...journal.filter((record) => namesEntry(record, identity)).map((record) => Date.parse(record.at)),
  );
}

function staleEntriesAbout(
  campaignEntries: readonly PageEntry[],
  page: readonly PageEntry[],
  journal: readonly JournalRecord[],
): PageEntry[] {
  const campaignWrittenAt = Math.max(...campaignEntries.map((entry) => lastWriteOf(entry.identity, journal)));
  const stale = new Map<string, PageEntry>();
  for (const other of campaignEntries.flatMap((entry) => entriesAboutTheSameWork(entry, page))) {
    if (lastWriteOf(other.identity, journal) < campaignWrittenAt && !saysItIsSuperseded(other)) {
      stale.set(other.identity, other);
    }
  }
  return [...stale.values()];
}

function stillSays(entry: PageEntry): string {
  return `"${entryHeadingOf(entry.identity)}" still says "${lineToFixIn(entry)}"`;
}

function refusal(alphaName: string, whatToDo: string): PageRecordVerdict {
  return { recorded: false, reason: `"${alphaName}" may not be completed yet: ${whatToDo}` };
}

export async function judgeCampaignPageRecord(
  alphaName: string,
  places: PageRecordPlaces = REAL_PAGE_RECORD_PLACES,
): Promise<PageRecordVerdict> {
  if (!(await isAlpha(alphaName, places.dataDir))) {
    return { recorded: true, summary: `${alphaName} is not an Alpha; it owes the page no entry` };
  }
  const objectiveCode = await objectiveCodeOf(alphaName, places.dataDir);
  if (objectiveCode === undefined) {
    return { recorded: true, summary: `${alphaName} carries no queue objective code; it owes the page no entry` };
  }
  if (queueRowWasAbandoned(objectiveCode, places.dataDir)) {
    return { recorded: true, summary: `queue row "${objectiveCode}" was abandoned; it owes the page no entry` };
  }
  const entryHeading = `"${entryHeadingOf(objectiveCode)}"`;
  const deliveryTime = await deliveryTimeOf(alphaName, places.dataDir);
  if (deliveryTime === undefined) {
    return refusal(
      alphaName,
      "write its REPORT.md first, " +
        `then record the campaign's outcome on the Lord's page as the entry ${entryHeading} with ${PAGE_EDIT_FLOW}.`,
    );
  }
  const journal = await readJournal(places.dataHome);
  const wroteAfterDelivery = journal.some(
    (record) =>
      Date.parse(record.at) > deliveryTime &&
      writerBelongsToCampaign(record.writer, alphaName, objectiveCode) &&
      namesEntry(record, objectiveCode),
  );
  if (!wroteAfterDelivery) {
    return refusal(
      alphaName,
      `record the campaign's outcome on the Lord's page by adding the entry ${entryHeading} under ` +
        `${SECTIONS_FOR_DELIVERED_WORK} with ${PAGE_EDIT_FLOW}, because no edit by this campaign since its REPORT.md names that entry.`,
    );
  }
  const page = listEntries((await showPage(places.dataHome)).content);
  const campaignEntries = page.filter((entry) => entry.identity === objectiveCode);
  if (campaignEntries.some((entry) => entry.section === PageSection.InFlight)) {
    return refusal(
      alphaName,
      `move the entry ${entryHeading} on the Lord's page out of "${sectionHeadingOf(PageSection.InFlight)}" to ` +
        `${SECTIONS_FOR_DELIVERED_WORK} with ${PAGE_EDIT_FLOW}.`,
    );
  }
  if (!campaignEntries.every(startsWithLinksLine)) {
    return refusal(
      alphaName,
      `start the entry ${entryHeading} on the Lord's page with its links line, ${LINKS_LINE_FORMS}, ` +
        `directly under its heading, with ${PAGE_EDIT_FLOW}.`,
    );
  }
  const staleEntries = staleEntriesAbout(campaignEntries, page, journal);
  if (staleEntries.length > 0) {
    return refusal(
      alphaName,
      `correct the older entries about the same work as ${entryHeading} on the Lord's page: ` +
        `${staleEntries.map(stillSays).join("; ")}. Remove each one, or correct that line and add the line ` +
        `"Superseded by \`${entryHeadingOf(objectiveCode)}\` on <date>", with ${PAGE_EDIT_FLOW}.`,
    );
  }
  return { recorded: true, summary: `"${objectiveCode}" was recorded on the page after ${alphaName} delivered` };
}

export async function refuseCompletionWithoutPageRecord(
  agentName: string,
  places: PageRecordPlaces = REAL_PAGE_RECORD_PLACES,
): Promise<string | undefined> {
  const verdict = await judgeCampaignPageRecord(agentName, places);
  return verdict.recorded ? undefined : verdict.reason;
}
