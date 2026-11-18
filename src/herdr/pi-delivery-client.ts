import path from "node:path";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import { MESSAGE_ID_PREFIX, REMEMBERED_DELIVERED_IDS } from "../../extensions/shared/agent-delivery-contract.ts";
import { deliverThroughExtension, type ExtensionDeliveryDeps, type ExtensionDeliveryOutcome } from "./delivery-request-client.ts";

export const PI_DELIVERY_EXTENSION_NAME = "throne-pi-delivery.ts";

export interface PiRecipient {
  readonly paneId: string;
  readonly agentName: string;
}

export function piAgentDirectory(agentName: string, dataDirectory: string = THRONE_DATA_DIR): string {
  return path.join(dataDirectory, agentName, "pi-agent");
}

export function piFallbackLine(agentName: string, reason: string): string {
  return `throne: the pi extension of "${agentName}" is not answering (${reason}), so the message goes by typed keys\n`;
}

const messagesThatFellBack = new Set<string>();

export function rememberPiFallback(agentName: string, messageId: number | undefined): boolean {
  if (messageId === undefined) return true;
  const key = `${agentName}:${messageId}`;
  if (messagesThatFellBack.has(key)) return false;
  messagesThatFellBack.add(key);
  if (messagesThatFellBack.size > REMEMBERED_DELIVERED_IDS) {
    messagesThatFellBack.delete(messagesThatFellBack.values().next().value!);
  }
  return true;
}

export async function deliverToPi(
  text: string,
  timeoutMs: number,
  recipient: PiRecipient,
  messageId?: number,
  deps: ExtensionDeliveryDeps = {},
): Promise<ExtensionDeliveryOutcome> {
  const socketPath = deps.socketPath ?? (await readSpawnSpec(recipient.agentName))?.delivery_socket;
  return deliverThroughExtension(text, timeoutMs, recipient.paneId, {
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(messageId === undefined ? {} : { requestId: `${MESSAGE_ID_PREFIX}${messageId}` }),
  });
}
