import { errorText } from "../shared-policy/error-text.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { canonicalIdentityName } from "../shared-identity/shared-identity.ts";

const SENDER_NAME_FLAG = "--sender-name";
const KEY_FLAG = "--key";
const CLEAR_BLOCKED_FLAG = "--clear-blocked";

const USAGE =
  "Usage: ./bin/throne-cli send-agent-legacy <recipient-name> <prompt...> " +
  `[${SENDER_NAME_FLAG} <name>]\n` +
  `[${KEY_FLAG} <key>]\n` +
  `[${CLEAR_BLOCKED_FLAG}]\n` +
  `${CLEAR_BLOCKED_FLAG} explicitly clears the recipient's durable blocked ` +
  "marker as part of this send, independent of the message content.\n" +
  "send-agent-legacy delivers synchronously through the platform " +
  "primitive, `herdr agent prompt <target> <text> --wait --timeout <ms>` " +
  "— it is the pre-queue fallback for when send-agent/queue-health " +
  "indicate the queue or throne-work server is broken. It owns the write " +
  "and the Enter; the throne resolves the recipient uniquely, attributes " +
  "the sender, holds the recipient pane lock (waiting for any resident " +
  "draft to clear first — it is never overwritten; the bounded wait times " +
  "out typed not-sent), flushes text found after acquisition before " +
  "submitting the payload once, backs large payloads to files, and maps " +
  "the platform's typed outcome to a typed not-sent/assumed-filled " +
  "verdict.\n" +
  "Multi-line: pass real newlines in one quoted argument, e.g. $'L1\\nL2'.\n";

export interface SendAgentLegacyInput {
  readonly recipientName: string;
  readonly prompt: string;
  readonly senderName?: string;
  readonly key?: string;
  readonly clearBlocked: boolean;
}

export function sendAgentLegacyInputError(error: unknown): string {
  return `send-agent-legacy: ${errorText(error)}\n${renderEntranceRefusal({
    reason: "Entrance validation refused this send-agent-legacy invocation.",
    bypass: undefined,
    supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
  })}\n${USAGE}`;
}

export function parseSendAgentLegacyInput(args: string[]): SendAgentLegacyInput {
  const recipientName = args[0];
  if (
    recipientName === undefined ||
    recipientName.length === 0 ||
    recipientName.startsWith("--")
  ) {
    throw new Error("missing required recipient agent name");
  }

  const promptParts: string[] = [];
  let senderName: string | undefined;
  let key: string | undefined;
  let clearBlocked = false;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === CLEAR_BLOCKED_FLAG) {
      clearBlocked = true;
      continue;
    }
    if (argument === SENDER_NAME_FLAG) {
      if (senderName !== undefined) {
        throw new Error(`duplicate ${SENDER_NAME_FLAG} flag`);
      }
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${SENDER_NAME_FLAG} needs a non-empty value`);
      }
      senderName = value;
      index += 1;
      continue;
    }
    if (argument === KEY_FLAG) {
      if (key !== undefined) throw new Error(`duplicate ${KEY_FLAG} flag`);
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${KEY_FLAG} needs a non-empty value`);
      }
      key = value;
      index += 1;
      continue;
    }
    promptParts.push(argument);
  }

  if (promptParts.length === 0) {
    throw new Error("missing required prompt");
  }

  return {
    recipientName: canonicalIdentityName(recipientName),
    prompt: promptParts.join(" "),
    senderName,
    key,
    clearBlocked,
  };
}
