import { deriveScheduledMessageDeliveryIdempotencyKey } from "../message-queue/message-delivery-idempotency.ts";
import type { SendAgentInput } from "./send-agent-input.ts";
import type { SendAgentCommandDependencies } from "./send-agent-dependencies.types.ts";
import { persistSqliteScheduledSend } from "./sqlite-scheduled-send.ts";

export async function runScheduledSendAgent(
  parsed: SendAgentInput,
  dependencies: SendAgentCommandDependencies,
): Promise<void> {
  const scheduledTiming = parsed.scheduled;
  if (scheduledTiming === undefined)
    throw new Error("scheduled delivery timing is required");
  const recipient = await dependencies.resolveAgent(parsed.recipientName);
  const senderName =
    parsed.senderName ?? (await dependencies.resolveCurrentAgentName());
  const recipientName = recipient.name ?? parsed.recipientName;
  const idempotencyKey = deriveScheduledMessageDeliveryIdempotencyKey(
    {
      recipientName,
      senderName,
      prompt: parsed.prompt,
      dueAtMs: scheduledTiming.dueAtMs,
    },
    parsed.key,
  );
  const scheduled = await (
    dependencies.scheduleSend ?? persistSqliteScheduledSend
  )({
    recipientName,
    senderName,
    prompt: parsed.prompt,
    key: idempotencyKey,
    clearBlocked: parsed.clearBlocked,
    dueAt: scheduledTiming.dueAt,
    dueAtMs: scheduledTiming.dueAtMs,
  });
  process.stdout.write(
    `send-agent: scheduled message ${scheduled.id} for ${scheduledTiming.dueAt}\n`,
  );
  process.exitCode = 0;
}
