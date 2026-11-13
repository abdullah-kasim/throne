import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ACCEPTANCE_DATA, type AcceptanceRecord } from "../agentdata/acceptance-data.service.ts";
import { DELIVERY_EVIDENCE_DATA } from "../agentdata/delivery-evidence-data.service.ts";
import {
  IdentityLineReadStatus,
  readAgentSupervisor,
} from "../agentdata/identity-data.service.ts";
import {
  completionReportPathForAgent,
  hasCompletionReportForAgent,
} from "../agentdata/ledger-data.service.ts";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import { readBlockedMarker } from "../agentdata/blocked-marker.service.ts";
import {
  classifyLastMessageTags,
  findLatestQualifyingReapabilityClaim,
} from "../no-idling/idle-pane-tag-classification.ts";
import { readClaimSeenAt } from "./claim-seen.ts";
import { sentMessageLedgerPath } from "../send-agent/sent-message-ledger.ts";

export const SUPERVISOR_WAIT_STEPS = {
  DONE_AWAITING_ACCEPTANCE: "done-awaiting-acceptance",
  ACCEPTED_AWAITING_GO_AHEAD: "accepted-awaiting-go-ahead",
  GO_AHEAD_SENT_AWAITING_CLAIM: "go-ahead-sent-awaiting-claim",
  CLAIMED_AWAITING_REAP: "claimed-awaiting-reap",
} as const;

export type SupervisorWaitStep =
  (typeof SUPERVISOR_WAIT_STEPS)[keyof typeof SUPERVISOR_WAIT_STEPS];

export type SupervisorWait =
  | { readonly waiting: false; readonly reason: string }
  | {
      readonly waiting: true;
      readonly step: SupervisorWaitStep;
      readonly supervisor: string;
      readonly since: Date;
    };

export interface SupervisorWaitInputs {
  readonly agentName: string;
  readonly paneText?: string;
  readonly dataDir?: string;
}

export async function readSupervisorWait(inputs: SupervisorWaitInputs): Promise<SupervisorWait> {
  try {
    return await readWaitFromLedger(inputs);
  } catch (error) {
    return { waiting: false, reason: `ledger data unreadable: ${(error as Error).message}` };
  }
}

async function readWaitFromLedger({
  agentName,
  paneText = "",
  dataDir = DEFAULT_DATA_DIR,
}: SupervisorWaitInputs): Promise<SupervisorWait> {
  const acceptance = await ACCEPTANCE_DATA.read(agentName, dataDir);
  const supervisorRead = await readAgentSupervisor(agentName, dataDir);
  if (supervisorRead.status !== IdentityLineReadStatus.Found || supervisorRead.value === "") {
    return { waiting: false, reason: "no supervisor recorded" };
  }
  const supervisor = supervisorRead.value;
  if (
    acceptance === null &&
    !(await hasCompletionReportForAgent(agentName, dataDir)) &&
    (await DELIVERY_EVIDENCE_DATA.read(agentName, dataDir)) === null
  ) {
    return readWaitBeforeAnyRecord(agentName, supervisor, paneText, dataDir);
  }
  if (acceptance === null) {
    return readWaitWithoutAcceptanceRecord(agentName, supervisor, dataDir);
  }
  return readWaitAfterAcceptance(acceptance, supervisor, paneText, agentName, dataDir);
}

async function readWaitBeforeAnyRecord(
  agentName: string,
  supervisor: string,
  paneText: string,
  dataDir: string,
): Promise<SupervisorWait> {
  const notWaiting = { waiting: false, reason: "no REPORT.md and not accepted" } as const;
  const tag = classifyLastMessageTags(paneText);
  const blockedOn = [
    ...(tag.kind === "blocked" ? tag.blockedBy : []),
    ...((await readBlockedMarker(agentName, dataDir))?.blockedBy ?? []),
  ];
  if (!blockedOn.some((name) => sameName(name, supervisor))) {
    return notWaiting;
  }
  const lastSentToSupervisor = await readLastSendTo(agentName, supervisor, dataDir);
  if (lastSentToSupervisor === undefined) return notWaiting;
  return waitingAt(SUPERVISOR_WAIT_STEPS.DONE_AWAITING_ACCEPTANCE, supervisor, lastSentToSupervisor);
}

async function readLastSendTo(
  sender: string,
  recipient: string,
  dataDir: string,
): Promise<Date | undefined> {
  const text = await readFile(sentMessageLedgerPath(sender, dataDir), "utf8").catch(() => "");
  let latest: Date | undefined;
  for (const line of text.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as { timestamp?: string; recipient?: string };
    if (entry.recipient === undefined || !sameName(entry.recipient, recipient)) continue;
    const sentAt = new Date(entry.timestamp ?? "");
    if (!Number.isNaN(sentAt.getTime()) && (latest === undefined || sentAt > latest)) latest = sentAt;
  }
  return latest;
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function readWaitWithoutAcceptanceRecord(
  agentName: string,
  supervisor: string,
  dataDir: string,
): Promise<SupervisorWait> {
  if ((await DELIVERY_EVIDENCE_DATA.read(agentName, dataDir)) !== null) {
    const merged = await stat(path.join(dataDir, agentName, "delivery-evidence.json"));
    return waitingAt(SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD, supervisor, merged.mtime);
  }
  const report = await stat(completionReportPathForAgent(agentName, dataDir)).catch(() => null);
  return waitingAt(
    SUPERVISOR_WAIT_STEPS.DONE_AWAITING_ACCEPTANCE,
    supervisor,
    report?.mtime ?? new Date(0),
  );
}

async function readWaitAfterAcceptance(
  acceptance: AcceptanceRecord,
  supervisor: string,
  paneText: string,
  agentName: string,
  dataDir: string,
): Promise<SupervisorWait> {
  const acceptedAt = parseRecordedTime(acceptance.acceptedAt);
  const goAhead = acceptance.goAhead;
  const goAheadSentAt = goAhead === undefined ? acceptedAt : parseRecordedTime(goAhead.sentAt);
  if (findLatestQualifyingReapabilityClaim(paneText) !== undefined) {
    const claimSeenAt = await readClaimSeenAt(agentName, dataDir);
    return waitingAt(SUPERVISOR_WAIT_STEPS.CLAIMED_AWAITING_REAP, supervisor, claimSeenAt ?? goAheadSentAt);
  }
  if (goAhead === undefined || goAhead.sendOutcome === "failed") {
    return waitingAt(SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD, supervisor, acceptedAt);
  }
  return waitingAt(SUPERVISOR_WAIT_STEPS.GO_AHEAD_SENT_AWAITING_CLAIM, supervisor, goAheadSentAt);
}

function parseRecordedTime(value: string): Date {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`unreadable time ${JSON.stringify(value)}`);
  return time;
}

function waitingAt(step: SupervisorWaitStep, supervisor: string, since: Date): SupervisorWait {
  return { waiting: true, step, supervisor, since };
}
