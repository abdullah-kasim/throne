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
import type { StoredPage, StoredRow } from "../web-api-contract/where-i-stand.ts";
import { connectToWhereIStand } from "../where-i-stand-store/where-i-stand-client.ts";
import { fileIsMissing } from "./file-presence.ts";
import { DELIVERED_SECTIONS, IN_FLIGHT, PUT_BY_NAME } from "./where-i-stand-messages.ts";
import { rowsAboutTheSameWork, stillSays } from "./same-work-entries.ts";

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

const SECTIONS_FOR_DELIVERED_WORK = DELIVERED_SECTIONS.map((section) => `"${section}"`).join(" or ");

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

async function readPage(dataHome: string): Promise<StoredPage> {
  const connection = connectToWhereIStand({ local: true, throneHome: dataHome });
  try {
    return await connection.operations.page();
  } finally {
    await connection.close();
  }
}

function topSectionNameOf(page: StoredPage, sectionId: string): string | undefined {
  let section = page.listing.sections.find((each) => each.id === sectionId);
  while (section?.parentId != null) {
    const parentId: string = section.parentId;
    section = page.listing.sections.find((each) => each.id === parentId);
  }
  return section?.name;
}

function staleRowsBeside(campaignRow: StoredRow, workRows: readonly StoredRow[]): StoredRow[] {
  return rowsAboutTheSameWork(campaignRow, workRows).filter((other) => Date.parse(other.changedAt) < Date.parse(campaignRow.changedAt));
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
  const entry = `"${objectiveCode}"`;
  const deliveryTime = await deliveryTimeOf(alphaName, places.dataDir);
  if (deliveryTime === undefined) {
    return refusal(alphaName, `write its REPORT.md first, then record the campaign's outcome on the Lord's page as the work entry ${entry} with ${PUT_BY_NAME}.`);
  }
  const page = await readPage(places.dataHome);
  const workRows = page.rows.filter((row) => row.kind === "work");
  const campaignRow = workRows.find((row) => row.code === objectiveCode);
  const wroteAfterDelivery =
    campaignRow !== undefined && Date.parse(campaignRow.changedAt) > deliveryTime && writerBelongsToCampaign(campaignRow.changedBy, alphaName, objectiveCode);
  if (campaignRow === undefined || !wroteAfterDelivery) {
    return refusal(
      alphaName,
      `record the campaign's outcome on the Lord's page by putting the work entry ${entry} under ${SECTIONS_FOR_DELIVERED_WORK} with ${PUT_BY_NAME}, ` +
        "because no write by this campaign since its REPORT.md holds that entry.",
    );
  }
  if (topSectionNameOf(page, campaignRow.sectionId) === IN_FLIGHT) {
    return refusal(alphaName, `move the work entry ${entry} on the Lord's page out of "${IN_FLIGHT}" to ${SECTIONS_FOR_DELIVERED_WORK} with ${PUT_BY_NAME}.`);
  }
  const staleRows = staleRowsBeside(campaignRow, workRows);
  if (staleRows.length > 0) {
    return refusal(
      alphaName,
      `archive the older entries about the same work as ${entry} on the Lord's page: ${staleRows.map(stillSays).join("; ")}. ` +
        `Archive each one with "throne where-i-stand archive <row id>".`,
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
