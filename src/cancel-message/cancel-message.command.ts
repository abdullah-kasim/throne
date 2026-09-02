import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { openMessageQueueStore } from "../message-queue/message-queue.store.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

export type CancelScheduledMessageResult = "cancelled" | "already-delivering" | "unauthorized";

async function readScheduledMessageSender(messageId: string): Promise<string | undefined> {
  const store = openMessageQueueStore();
  try {
    const item = store.readWorkItem(Number(messageId));
    const payload = item?.payload;
    return item?.dueAt !== null && typeof payload === "object" && payload !== null &&
      "senderName" in payload && typeof payload.senderName === "string"
      ? payload.senderName
      : undefined;
  } finally {
    store.close();
  }
}

async function cancelScheduledMessage(
  messageId: string,
  requesterName: string,
): Promise<CancelScheduledMessageResult> {
  if (await readScheduledMessageSender(messageId) !== requesterName) {
    return "unauthorized";
  }
  const store = openMessageQueueStore();
  try {
    return store.cancelQueuedWorkItem(Number(messageId)) === undefined
      ? "already-delivering"
      : "cancelled";
  } finally {
    store.close();
  }
}

export interface CancelMessageCommandDependencies {
  resolveCurrentAgentName(): Promise<string>;
  cancelScheduledMessage(messageId: string, requesterName: string): Promise<CancelScheduledMessageResult>;
}

@Command({ name: "cancel-message", allowUnknownOptions: true, allowExcessArgs: true })
export class CancelMessageCommand extends CommandRunner {
  constructor(private readonly dependencies?: CancelMessageCommandDependencies) {
    super();
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    let messageId: string;
    try {
      messageId = parseMessageId(passedParams);
    } catch (error) {
      process.stderr.write(
        `cancel-message: ${error instanceof Error ? error.message : String(error)}\n${renderEntranceRefusal({
          reason: "cancel-message entrance validation requires exactly one scheduled message ID.",
          bypass: undefined,
          supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
        })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const requesterName = await (this.dependencies?.resolveCurrentAgentName ?? resolveCurrentAgentName)();
    const result = await (this.dependencies?.cancelScheduledMessage ?? cancelScheduledMessage)(messageId, requesterName);
    process.stdout.write(`cancel-message: ${result} message ${messageId}\n`);
    process.exitCode = result === "cancelled" ? 0 : 1;
  }
}

function parseMessageId(args: readonly string[]): string {
  if (args.length !== 1 || args[0] === undefined || !/^[1-9]\d*$/.test(args[0])) {
    throw new Error("Usage: ./bin/throne-cli cancel-message <message-id>");
  }
  return args[0];
}
