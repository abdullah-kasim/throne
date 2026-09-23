import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";

export const AmendmentRoute = {
  RecordBeforeLaunch: "record-before-launch",
  RecordAndTellCampaign: "record-and-tell-campaign",
  RefuseAlreadyDelivered: "refuse-already-delivered",
  RefuseNoSuchRow: "refuse-no-such-row",
} as const;

export type AmendmentRouteDecision =
  | { readonly route: typeof AmendmentRoute.RecordBeforeLaunch }
  | {
      readonly route: typeof AmendmentRoute.RecordAndTellCampaign;
      readonly alphaName: string | null;
    }
  | {
      readonly route: typeof AmendmentRoute.RefuseAlreadyDelivered;
      readonly reason: string;
    }
  | {
      readonly route: typeof AmendmentRoute.RefuseNoSuchRow;
      readonly reason: string;
    };

export interface AmendmentRowFacts {
  readonly objectiveCode: string;
  readonly status: RegentQueueItemStatus;
  readonly alphaName: string | null;
  readonly deliveredCommit: string | null;
  readonly deliveryBranch: string | null;
  readonly alphaHasWrittenItsReport: boolean;
}

const FINISHED_STATUSES: ReadonlySet<RegentQueueItemStatus> = new Set([
  RegentQueueItemStatus.Complete,
  RegentQueueItemStatus.Abandoned,
]);

const NOT_YET_LAUNCHED_STATUSES: ReadonlySet<RegentQueueItemStatus> = new Set([
  RegentQueueItemStatus.Open,
  RegentQueueItemStatus.Deferred,
]);

function hasAlreadyDelivered(row: AmendmentRowFacts): boolean {
  return (
    FINISHED_STATUSES.has(row.status) ||
    row.deliveredCommit !== null ||
    row.alphaHasWrittenItsReport
  );
}

function describeAlpha(row: AmendmentRowFacts): string {
  return row.alphaName === null ? "its Alpha" : `its Alpha ${row.alphaName}`;
}

function describeDelivery(row: AmendmentRowFacts): string {
  const where = row.deliveryBranch ?? "its delivered branch";
  const evidence =
    row.deliveredCommit !== null
      ? `delivered ${where} at ${row.deliveredCommit}`
      : row.alphaHasWrittenItsReport
        ? `is finished: ${describeAlpha(row)} has already written REPORT.md`
        : `is ${row.status}`;
  return (
    `queue objective "${row.objectiveCode}" ${evidence}, so no one would ever act on an amendment to it. ` +
    `File a NEW objective against ${where} instead (/queue-objective), quoting the Lord's words there.`
  );
}

export function decideAmendmentRoute(
  objectiveCode: string,
  row: AmendmentRowFacts | undefined,
): AmendmentRouteDecision {
  if (row === undefined) {
    return {
      route: AmendmentRoute.RefuseNoSuchRow,
      reason:
        `no queue row is named "${objectiveCode}" (check \`throne render-queue --all\`). ` +
        `An amendment needs a row to attach to; file a new objective with /queue-objective instead.`,
    };
  }
  if (hasAlreadyDelivered(row)) {
    return {
      route: AmendmentRoute.RefuseAlreadyDelivered,
      reason: describeDelivery(row),
    };
  }
  if (NOT_YET_LAUNCHED_STATUSES.has(row.status)) {
    return { route: AmendmentRoute.RecordBeforeLaunch };
  }
  return {
    route: AmendmentRoute.RecordAndTellCampaign,
    alphaName: row.alphaName,
  };
}
