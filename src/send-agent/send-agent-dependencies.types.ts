import type { MessageQueueStore } from "../message-queue/message-queue.store.ts";
import type { recordDeliveredSupervisionEvent } from "../alpha-monitoring/alpha-monitoring.ts";
import type { checkAndNotifySustainedOutage } from "../throne-work/sustained-outage-notifier.ts";
import type { IdentityDataService } from "../agentdata/identity-data.service.ts";
import type { clearBlockedMarker } from "../agentdata/blocked-marker.service.ts";
import type { markAgentTasked } from "../agentdata/spawn-data-contracts.ts";
import type {
  appendSentMessageLedgerEntry,
  SentMessageTransport,
} from "./sent-message-ledger.ts";
import type * as runtimeModelTaskAcceptance from "./runtime-model-task-acceptance.ts";

export interface SendAgentCommandDependencies<
  Recipient extends { name?: string; paneId?: string } = {
    name?: string;
    paneId?: string;
  },
> {
  resolveAgent(name: string): Promise<Recipient>;
  resolveCurrentAgentName(): Promise<string>;
  submitToAgent(
    recipient: Recipient,
    senderName: string,
    prompt: string,
    options: { key?: string; onDeliveredWhileLocked?: () => Promise<void> },
  ): Promise<void>;
  openMessageQueueStore?: () => MessageQueueStore;
  now?: () => number;
  readAgentRole?: IdentityDataService["readAgentRole"];
  readAgentSupervisor?: IdentityDataService["readAgentSupervisor"];
  recordDeliveredEvent?: typeof recordDeliveredSupervisionEvent;
  clearBlockedMarker?: typeof clearBlockedMarker;
  checkSustainedOutage?: typeof checkAndNotifySustainedOutage;
  // Spawn+task atomicity bookkeeping: closes off the recipient's
  // `tasked_at: null` window the moment it is genuinely sent a task, so a
  // later `find-untasked-agents` sweep never flags it. Best-effort by
  // contract (see `markAgentTasked`) — every call site swallows its
  // rejection so this can never fail the actual send.
  markAgentTasked?: typeof markAgentTasked;
  // Durable delivery-observability mechanism: appends one record per
  // accepted send to the sender's ledger, independent of whether the caller
  // captured or discarded stdout. Best-effort by contract (see
  // `recordSentMessage`) — every call site swallows its rejection so this
  // can never fail the actual send.
  appendSentMessageLedgerEntry?: typeof appendSentMessageLedgerEntry;
  scheduleSend?: (request: {
    recipientName: string;
    senderName: string;
    prompt: string;
    key?: string;
    clearBlocked: boolean;
    dueAt: string;
    dueAtMs: number;
  }) => Promise<{ id: string }>;
  checkRuntimeModelAcceptance?: runtimeModelTaskAcceptance.CheckTaskRuntimeModelAcceptance;
}
