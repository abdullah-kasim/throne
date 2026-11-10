import {
  IdentityLineReadStatus,
  readAgentObjectiveCode,
  readAgentRole,
} from "../agentdata/identity-data.service.ts";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { orderQueueItemsForDispatch } from "../regent-queue/regent-queue-dispatch.ts";
import {
  LIVE_QUEUE_ITEM_STATUSES,
  renderRegentQueueAsMarkdown,
} from "../regent-queue/regent-queue-render.ts";
import type {
  RegentQueueItemRow,
  RegentQueueReadResult,
} from "../regent-queue/regent-queue.store.ts";
import { REGENT_NAME } from "../regent-state/regent-state.service.ts";

export type DigestReader =
  | { readonly kind: "whole-queue" }
  | { readonly kind: "stager" }
  | { readonly kind: "campaign"; readonly objectiveCode: string };

export const WHOLE_QUEUE_READER: DigestReader = { kind: "whole-queue" };

export async function resolveDigestReader(
  name: string | undefined,
  dataDirectory: string = DEFAULT_DATA_DIR,
): Promise<DigestReader> {
  if (!name || sameAgentName(name, REGENT_NAME)) return WHOLE_QUEUE_READER;
  const role = await readAgentRole(name, dataDirectory);
  if (role.status !== IdentityLineReadStatus.Found) return WHOLE_QUEUE_READER;
  if (role.value === "Stager") return { kind: "stager" };
  if (role.value !== "Alpha" && role.value !== "Shadow") return WHOLE_QUEUE_READER;
  const objectiveCode = await readAgentObjectiveCode(name, dataDirectory);
  if (objectiveCode.status !== IdentityLineReadStatus.Found || !objectiveCode.value) {
    return WHOLE_QUEUE_READER;
  }
  return { kind: "campaign", objectiveCode: objectiveCode.value };
}

function liveRowsOf(result: RegentQueueReadResult): RegentQueueItemRow[] {
  if (result.state !== "items") return [];
  return orderQueueItemsForDispatch(
    result.items.filter((item) => LIVE_QUEUE_ITEM_STATUSES.includes(item.status)),
  );
}

function belongsToObjective(item: RegentQueueItemRow, objectiveCode: string): boolean {
  return item.objectiveCode?.toLowerCase() === objectiveCode.toLowerCase();
}

function otherRowsPointer(count: number): string {
  return `${count} other live rows; \`throne render-queue\` shows them\n`;
}

function rowSummaryLine(item: RegentQueueItemRow): string {
  return (
    `- ${item.objectiveCode ?? item.id} (${item.status}), ` +
    `agent: ${item.agentName ?? "none"}, repository: ${item.targetRepo ?? "none"}`
  );
}

function renderCampaignDigest(liveRows: RegentQueueItemRow[], objectiveCode: string): string {
  const ownRows = liveRows.filter((item) => belongsToObjective(item, objectiveCode));
  const pointer = otherRowsPointer(liveRows.length - ownRows.length);
  if (ownRows.length === 0) return pointer;
  const ownDigest = renderRegentQueueAsMarkdown({ state: "items", items: ownRows });
  return `${ownDigest}\n${pointer}`;
}

function renderStagerDigest(liveRows: RegentQueueItemRow[]): string {
  const lines = liveRows.map(rowSummaryLine).join("\n");
  return `${lines}\n\n${otherRowsPointer(liveRows.length)}`;
}

export function renderQueueDigestFor(
  result: RegentQueueReadResult,
  reader: DigestReader,
): string {
  const liveRows = liveRowsOf(result);
  if (reader.kind === "whole-queue" || liveRows.length === 0) {
    return renderRegentQueueAsMarkdown(result, { statuses: LIVE_QUEUE_ITEM_STATUSES });
  }
  if (reader.kind === "stager") return renderStagerDigest(liveRows);
  return renderCampaignDigest(liveRows, reader.objectiveCode);
}
