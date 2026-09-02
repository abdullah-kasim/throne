import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { readPromptFile } from "./prompt-file.ts";
import {
  parseSendAgentInput,
  suspectedFlagPrefixWarning,
  sendAgentInputError,
  type SendAgentInput,
} from "./send-agent-input.ts";
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
  formatDegradedCourtWarning,
  isHeartbeatStale,
} from "./message-delivery-enqueue.ts";
import { openMessageQueueStore } from "../message-queue/message-queue.store.ts";
import { deriveDefaultMessageDeliveryIdempotencyKey } from "../message-queue/message-delivery-idempotency.ts";
import { productionAlphaMonitoringDependencies } from "../alpha-monitoring/alpha-monitoring.ts";
import { checkAndNotifySustainedOutage } from "../throne-work/sustained-outage-notifier.ts";
import { clearBlockedMarker } from "../agentdata/blocked-marker.service.ts";
import { markAgentTasked } from "../agentdata/spawn-data-contracts.ts";
import {
  identityFieldForRecording,
} from "../agentdata/identity-data.service.ts";
import {
  appendSentMessageLedgerEntry,
  type SentMessageTransport,
} from "./sent-message-ledger.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { submitToAgent } from "../herdr/herdr-send.service.ts";
import {
  SubmitAssumedFilledError,
  SubmitNotSentError,
} from "../herdr/herdr-send.types.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { runScheduledSendAgent } from "./scheduled-send-agent.ts";
import { warnOfUnacknowledgedDeliveryFailures } from "./delivery-failure-warning.ts";
import * as runtimeModelTaskAcceptance from "./runtime-model-task-acceptance.ts";
import type { SendAgentCommandDependencies } from "./send-agent-dependencies.types.ts";

/** Distinguishable exit codes for the `--direct` escape hatch's pane-write verdicts; `delivered` keeps the existing 0. */
const DIRECT_SEND_EXIT_CODE = {
  notSent: 1,
  assumedFilled: 2,
} as const;

let productionDependencies: SendAgentCommandDependencies | undefined;

const DEFAULT_PRODUCTION_DEPENDENCIES: SendAgentCommandDependencies = {
  resolveAgent,
  resolveCurrentAgentName,
  submitToAgent,
  openMessageQueueStore: () => openMessageQueueStore(),
  now: () => Date.now(),
  clearBlockedMarker,
  checkSustainedOutage: checkAndNotifySustainedOutage,
  markAgentTasked,
  appendSentMessageLedgerEntry,
  checkRuntimeModelAcceptance:
    runtimeModelTaskAcceptance.checkAgentRuntimeModelAcceptance,
};

export function configureSendAgentCommandDependencies(
  dependencies: SendAgentCommandDependencies,
): void {
  productionDependencies = dependencies;
}

@Command({
  name: "send-agent",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SendAgentCommand extends CommandRunner {
  private readonly dependencies?: SendAgentCommandDependencies;

  constructor(dependencies?: SendAgentCommandDependencies) {
    super();
    this.dependencies = dependencies;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    let parsed: SendAgentInput;
    try {
      parsed = parseSendAgentInput(passedParams);
      if (parsed.promptFile !== undefined) {
        // Read here rather than in the parser: parsing stays pure and
        // synchronously testable, and the I/O refusal still happens before
        // any queue write, so a bad path fails clean with nothing sent.
        parsed = { ...parsed, prompt: await readPromptFile(parsed.promptFile) };
      }
    } catch (error) {
      process.stderr.write(sendAgentInputError(error));
      process.exitCode = 1;
      return;
    }

    // Non-blocking: the message is already parsed and will be sent. This only
    // restores the signal the sender was missing. See
    // `suspectedFlagPrefixWarning`.
    const flagPrefixWarning = suspectedFlagPrefixWarning(parsed.prompt);
    if (flagPrefixWarning !== undefined) {
      process.stderr.write(flagPrefixWarning);
    }

    const dependencies =
      this.dependencies ??
      productionDependencies ??
      DEFAULT_PRODUCTION_DEPENDENCIES;

    if (
      await runtimeModelTaskAcceptance.refuseTaskOnRuntimeModelMismatch(
        parsed.recipientName,
        dependencies.checkRuntimeModelAcceptance,
      )
    )
      return;

    if (parsed.scheduled !== undefined) {
      await runScheduledSendAgent(parsed, dependencies);
      return;
    }
    if (parsed.direct) {
      await runDirectSendAgent(parsed, dependencies);
      return;
    }
    try {
      await runEnqueueSendAgent(parsed, dependencies);
    } catch (error) {
      process.stderr.write(
        `send-agent: ${error instanceof Error ? error.message : String(error)}\n${renderEntranceRefusal({ reason: "send-agent refused the recipient before any queue write.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n`,
      );
      process.exitCode = 1;
    }
  }
}

/**
 * The proactive half of closed-loop delivery reporting: on every ordinary
 * send, check whether *this* sender has any of its own past sends sitting
 * unacknowledged as terminal failures, and surface them to stderr before
 * moving on. This never blocks or fails the current send — it is the
 * "next natural touchpoint" a sender hits, not a new polling loop, and it
 * fires only when a notice actually exists, so the 789-of-831 ordinary
 * case stays silent. Read-only: it does not acknowledge what it prints,
 * so a sender who misses the banner still finds it via `delivery-failures`.
 */
/**
 * Best-effort wrapper around `dependencies.markAgentTasked` — every call
 * site invokes this instead of the dependency directly so a ledger I/O
 * failure can never turn a successful send into a failed one.
 */
async function recordAgentTasked(
  dependencies: SendAgentCommandDependencies,
  recipientName: string,
  now: () => number,
): Promise<void> {
  try {
    await dependencies.markAgentTasked?.(
      recipientName,
      new Date(now()).toISOString(),
    );
  } catch (error) {
    process.stderr.write(
      `send-agent: tasked-bookkeeping failed, ignoring: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/**
 * Best-effort wrapper around `dependencies.appendSentMessageLedgerEntry` —
 * every accept path calls this instead of the dependency directly so a
 * ledger I/O failure can never turn a successful send into a failed one.
 */
async function recordSentMessage(
  dependencies: SendAgentCommandDependencies,
  entry: {
    senderName: string;
    recipientName: string;
    id: string;
    transport: SentMessageTransport;
    sentAtMs: number;
  },
): Promise<void> {
  try {
    await dependencies.appendSentMessageLedgerEntry?.(entry);
  } catch (error) {
    process.stderr.write(
      `send-agent: sent-message ledger write failed, ignoring: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/**
 * The enqueue-and-exit default path: resolve recipient and sender exactly as
 * today, write one durable `message-delivery` work item, clear the sender's
 * own blocked marker on acceptance, and exit — no pane I/O, ever.
 */
async function runEnqueueSendAgent(
  parsed: SendAgentInput,
  dependencies: SendAgentCommandDependencies,
): Promise<void> {
  const recipient = await dependencies.resolveAgent(parsed.recipientName);
  const senderName =
    parsed.senderName ?? (await dependencies.resolveCurrentAgentName());

  const openStore =
    dependencies.openMessageQueueStore ?? (() => openMessageQueueStore());

  const now = dependencies.now ?? (() => Date.now());
  const store = openStore();
  let item;
  try {
    if (isHeartbeatStale(store.readHeartbeat(), now())) {
      process.stderr.write(formatDegradedCourtWarning());
    }
    warnOfUnacknowledgedDeliveryFailures(store, senderName);
    const recipientName = recipient.name ?? parsed.recipientName;
    const idempotencyKey =
      parsed.key ??
      deriveDefaultMessageDeliveryIdempotencyKey(
        { recipientName, senderName, prompt: parsed.prompt },
        now(),
      );
    item = enqueueMessageDelivery(
      store,
      buildMessageDeliveryWorkItemPayload({
        recipientName,
        recipientPaneId: recipient.paneId ?? "",
        senderName,
        prompt: parsed.prompt,
        key: idempotencyKey,
        clearRecipientBlockedOnDelivery: parsed.clearBlocked,
      }),
    );
    // A dead/wedged court is worth an out-of-band notify-lord alert, not
    // just this call's own stderr warning — a systemd-unit caller's stderr
    // reaches only the journal. This is one of the two named observers;
    // `queue-health` is the other. Non-fatal: an enqueue must never fail
    // because the alerting side-channel had trouble.
    try {
      await dependencies.checkSustainedOutage?.(store, now);
    } catch (error) {
      process.stderr.write(
        `send-agent: sustained-outage check failed, ignoring: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  } finally {
    store.close();
  }

  await dependencies.clearBlockedMarker?.(senderName);
  await recordAgentTasked(
    dependencies,
    recipient.name ?? parsed.recipientName,
    now,
  );
  await recordSentMessage(dependencies, {
    senderName,
    recipientName: recipient.name ?? parsed.recipientName,
    id: String(item.id),
    transport: "sqlite",
    sentAtMs: now(),
  });
  // A bare integer here is genuinely dangerous, not just ugly: enqueue IDs
  // and message-server response codes overlap in range, and a reader (human
  // or model) who sees a naked "404" after a network-ish call reads it as an
  // HTTP failure and resends — which, on a call that was actually assumed
  // filled rather than confirmed delivered, double-delivers. Label it so the
  // success case is unmistakably a success case.
  process.stdout.write(
    `send-agent: queued as message ${item.id}; delivery begins within approximately one second. ` +
      `Use --direct only for urgent recovery when the queue/server path is confirmed broken.\n`,
  );
  process.exitCode = 0;
}


/**
 * The `--direct` escape hatch: today's synchronous pane-write path,
 * unchanged, for manual recovery when the queue/server path is confirmed
 * broken.
 */
async function runDirectSendAgent(
  parsed: SendAgentInput,
  dependencies: SendAgentCommandDependencies,
): Promise<void> {
  const recipient = await dependencies.resolveAgent(parsed.recipientName);
  let actualSenderName =
    parsed.senderName === undefined
      ? await dependencies.resolveCurrentAgentName()
      : undefined;
  const senderName = parsed.senderName ?? actualSenderName!;
  const canRecordEvent =
    dependencies.readAgentRole !== undefined &&
    dependencies.readAgentSupervisor !== undefined &&
    dependencies.recordDeliveredEvent !== undefined;
  const onDeliveredWhileLocked = canRecordEvent
    ? async () => {
        if (actualSenderName === undefined) {
          try {
            actualSenderName = await dependencies.resolveCurrentAgentName();
          } catch {
            return;
          }
        }
        try {
          const recipientName = recipient.name ?? parsed.recipientName;
          await dependencies.recordDeliveredEvent!(
            {
              sender: actualSenderName,
              senderRole: identityFieldForRecording(
                await dependencies.readAgentRole!(actualSenderName),
              ),
              senderSupervisor: identityFieldForRecording(
                await dependencies.readAgentSupervisor!(actualSenderName),
              ),
              recipient: recipientName,
              recipientRole: identityFieldForRecording(
                await dependencies.readAgentRole!(recipientName),
              ),
              prompt: parsed.prompt,
            },
            productionAlphaMonitoringDependencies(async () => null),
          );
        } catch (error) {
          process.stderr.write(
            `send-agent: delivered, but supervision event recording failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    : undefined;
  try {
    await dependencies.submitToAgent(recipient, senderName, parsed.prompt, {
      ...(parsed.key === undefined ? {} : { key: parsed.key }),
      ...(onDeliveredWhileLocked === undefined
        ? {}
        : { onDeliveredWhileLocked }),
    });
  } catch (error) {
    if (error instanceof SubmitNotSentError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = DIRECT_SEND_EXIT_CODE.notSent;
      return;
    }
    if (error instanceof SubmitAssumedFilledError) {
      // A composer has exactly two states: empty or filled. A third verdict
      // for "we couldn't tell" would encode our own uncertainty about the
      // observation as if it were the composer's own state — so this
      // command never surfaces one. `SubmitAssumedFilledError` already means
      // herdr looked, couldn't tell, ran out of looks, and assumed filled;
      // this branch reports that assumed-filled verdict, it does not invent
      // a third exit code for it.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = DIRECT_SEND_EXIT_CODE.assumedFilled;
      return;
    }
    throw error;
  }
  await dependencies.clearBlockedMarker?.(senderName);
  if (parsed.clearBlocked) {
    await dependencies.clearBlockedMarker?.(
      recipient.name ?? parsed.recipientName,
    );
  }
  await recordAgentTasked(
    dependencies,
    recipient.name ?? parsed.recipientName,
    dependencies.now ?? (() => Date.now()),
  );
  // Silent success here reads the same as "nothing happened" — label it so a
  // successful --direct delivery is as unmistakable as the enqueue path's.
  process.stdout.write(
    `send-agent: delivered directly to "${recipient.name ?? parsed.recipientName}"\n`,
  );
  process.exitCode = 0;
}
