import { formatDeliveryFailureNotice } from "../delivery-failures/delivery-failures.ts";
import type { MessageQueueStore } from "../message-queue/message-queue.store.ts";

export function warnOfUnacknowledgedDeliveryFailures(
  store: MessageQueueStore,
  senderName: string,
): void {
  try {
    const notices = store.listUnacknowledgedDeliveryFailureNotices(senderName);
    if (notices.length === 0) return;
    process.stderr.write(
      `send-agent: ${notices.length} of your past send(s) never delivered — ` +
        `run \`delivery-failures ${senderName}\` for details, then ` +
        `\`delivery-failures --ack <id>\` once handled:\n`,
    );
    for (const notice of notices) {
      process.stderr.write(formatDeliveryFailureNotice(notice));
    }
  } catch (error) {
    process.stderr.write(
      `send-agent: delivery-failure check failed, ignoring: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}
