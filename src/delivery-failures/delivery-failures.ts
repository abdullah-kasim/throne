import {
  openMessageQueueStore,
  type DeliveryFailureNoticeRow,
  type MessageQueueStore,
} from "../message-queue/message-queue.store.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

/**
 * The sender-facing half of closed-loop delivery reporting: a durable poll
 * surface over `delivery_failure_notices` (written synchronously by
 * `MessageQueueStore.transitionWorkItemState` whenever a work item
 * terminal-fails). Read-only listing never acknowledges — only an explicit
 * `--ack <id>` does, so viewing a notice can never make it silently
 * disappear before the sender has actually acted on it.
 */

export const DELIVERY_FAILURES_EXIT = {
  Success: 0,
  Usage: 64,
} as const;

export interface DeliveryFailuresDeps {
  openStore: () => MessageQueueStore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const REAL_DEPS: DeliveryFailuresDeps = {
  openStore: openMessageQueueStore,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

interface ParsedDeliveryFailuresInput {
  readonly senderName?: string;
  readonly ackId?: number;
}

function parseDeliveryFailuresInput(
  args: readonly string[],
): ParsedDeliveryFailuresInput | undefined {
  if (args.length === 2 && args[0] === "--ack") {
    const ackId = Number(args[1]);
    if (!Number.isInteger(ackId) || ackId <= 0) return undefined;
    return { ackId };
  }
  if (args.length === 1 && args[0] !== undefined && args[0].length > 0) {
    return { senderName: args[0] };
  }
  return undefined;
}

export function formatDeliveryFailureNotice(notice: DeliveryFailureNoticeRow): string {
  const recipient = notice.recipientName ?? "(unknown recipient)";
  const when = new Date(notice.createdAt).toISOString();
  return (
    `[notice ${notice.id}] work item ${notice.workItemId} to ${recipient} ` +
    `terminalised as failed at ${when}: ${notice.failureReason}\n`
  );
}

export async function runDeliveryFailures(
  args: readonly string[],
  deps: DeliveryFailuresDeps = REAL_DEPS,
): Promise<number> {
  const parsed = parseDeliveryFailuresInput(args);
  if (parsed === undefined) {
    deps.stderr(
      "delivery-failures: usage:\n" +
        "  ./bin/throne-cli delivery-failures <senderName>   list unacknowledged notices for a sender\n" +
        "  ./bin/throne-cli delivery-failures --ack <id>     acknowledge one notice by id\n",
    );
    deps.stderr(
      `${renderEntranceRefusal({
        reason: "delivery-failures entrance validation requires a sender name or positive --ack id.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return DELIVERY_FAILURES_EXIT.Usage;
  }

  const store = deps.openStore();
  try {
    if (parsed.ackId !== undefined) {
      const acknowledged = store.acknowledgeDeliveryFailureNotice(parsed.ackId);
      deps.stdout(
        acknowledged === undefined
          ? `delivery-failures: no unacknowledged notice ${parsed.ackId}\n`
          : `delivery-failures: acknowledged notice ${parsed.ackId}\n`,
      );
      return DELIVERY_FAILURES_EXIT.Success;
    }

    const notices = store.listUnacknowledgedDeliveryFailureNotices(parsed.senderName!);
    if (notices.length === 0) {
      deps.stdout(`delivery-failures: no unacknowledged notices for ${parsed.senderName}\n`);
      return DELIVERY_FAILURES_EXIT.Success;
    }
    for (const notice of notices) {
      deps.stdout(formatDeliveryFailureNotice(notice));
    }
    return DELIVERY_FAILURES_EXIT.Success;
  } finally {
    store.close();
  }
}
