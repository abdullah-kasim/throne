import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import {
  MessageStatusVerdict,
  readMessageStatus,
} from "../message-status/message-status.ts";
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
} from "../send-agent/message-delivery-enqueue.ts";
import { openMessageQueueStore, type MessageQueueStore } from "./message-queue.store.ts";

export const VERIFY_DELIVERY_POLL_WINDOW_MS = 20_000;
export const VERIFY_DELIVERY_POLL_INTERVAL_MS = 250;

export interface VerifyDeliveryPathDeps {
  readonly resolveCurrentAgentName: () => Promise<string>;
  readonly resolveSenderName?: () => Promise<string>;
  readonly openStore: () => MessageQueueStore;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pollWindowMs: number;
  readonly pollIntervalMs: number;
}

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export const REAL_DEPS: VerifyDeliveryPathDeps = {
  resolveCurrentAgentName,
  openStore: openMessageQueueStore,
  now: Date.now,
  sleep,
  pollWindowMs: VERIFY_DELIVERY_POLL_WINDOW_MS,
  pollIntervalMs: VERIFY_DELIVERY_POLL_INTERVAL_MS,
};

export interface VerifyDeliveryPathResult {
  readonly passed: boolean;
  readonly verdict: MessageStatusVerdict;
}

export async function verifyDeliveryPath(
  deps: VerifyDeliveryPathDeps = REAL_DEPS,
): Promise<VerifyDeliveryPathResult> {
  const recipientName = await deps.resolveCurrentAgentName();
  const senderName = deps.resolveSenderName ? await deps.resolveSenderName() : recipientName;
  const store = deps.openStore();
  try {
    const probe = enqueueMessageDelivery(
      store,
      buildMessageDeliveryWorkItemPayload({
        recipientName,
        recipientPaneId: "",
        senderName,
        prompt: "delivery-path probe — safe to ignore, reachability check.",
        clearRecipientBlockedOnDelivery: false,
      }),
    );
    const deadline = deps.now() + deps.pollWindowMs;
    let verdict = readMessageStatus(store, probe.id, deps.now).verdict;
    while (
      deps.now() < deadline &&
      (verdict === MessageStatusVerdict.Queued ||
        verdict === MessageStatusVerdict.Scheduled ||
        verdict === MessageStatusVerdict.InFlight)
    ) {
      await deps.sleep(deps.pollIntervalMs);
      verdict = readMessageStatus(store, probe.id, deps.now).verdict;
    }
    return { passed: verdict === MessageStatusVerdict.Delivered, verdict };
  } finally {
    store.close();
  }
}


export function resultLine(result: VerifyDeliveryPathResult): string {
  return result.passed
    ? `PASS — the SQLite delivery probe reached the recipient pane within the window (verdict: ${result.verdict}).\n`
    : `FAIL — the SQLite delivery probe did not reach a delivered verdict (got: ${result.verdict}).\n`;
}

@Command({
  name: "verify-delivery-path",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class VerifyDeliveryPathCommand extends CommandRunner {
  private readonly deps: VerifyDeliveryPathDeps | undefined;

  constructor(deps?: VerifyDeliveryPathDeps) {
    super();
    this.deps = deps;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(): Promise<void> {
    const result = await verifyDeliveryPath(this.deps);
    process.stdout.write(resultLine(result));
    process.exitCode = result.passed ? 0 : 1;
  }
}
