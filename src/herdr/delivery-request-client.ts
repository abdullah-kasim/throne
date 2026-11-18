import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  ALIVE_PATH,
  ALIVE_TIMEOUT_MILLISECONDS,
  COMMAND_ID_PREFIX,
  CONNECT_TIMEOUT_MILLISECONDS,
  DELIVER_PATH,
  MESSAGE_ID_PREFIX,
  SENDER_MARGIN_MILLISECONDS,
  type AliveAnswer,
  type DeliveryAnswer,
  type DeliveryRequest,
} from "../../extensions/shared/agent-delivery-contract.ts";

export const HERDR_PANE_ID_ENV = "HERDR_PANE_ID";

export interface HarnessCommandRequest {
  readonly command: string;
  readonly args: string;
}

export type ExtensionDeliveryOutcome =
  | { readonly kind: "delivered" }
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "timed-out"; readonly waitedMs: number }
  | { readonly kind: "not-answering"; readonly detail: string }
  | { readonly kind: "dropped"; readonly detail: string };

export interface ExtensionDeliveryDeps {
  readonly socketPath?: string;
  readonly requestId?: string;
}

type Exchange =
  | { readonly kind: "answered"; readonly body: string }
  | { readonly kind: "no-connection"; readonly detail: string }
  | { readonly kind: "dropped"; readonly detail: string }
  | { readonly kind: "no-answer" };

function exchangeOverSocket(
  socketPath: string,
  method: "GET" | "POST",
  route: string,
  body: string | undefined,
  answerLimitMs: number,
): Promise<Exchange> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(answerTimer);
      outgoing.destroy();
      resolve(result);
    };
    const outgoing = httpRequest({ socketPath, method, path: route, headers: { "content-type": "application/json" } });
    let connected = false;
    const connectTimer = setTimeout(
      () => finish({ kind: "no-connection", detail: `no connection to ${socketPath} within ${CONNECT_TIMEOUT_MILLISECONDS}ms` }),
      CONNECT_TIMEOUT_MILLISECONDS,
    );
    const answerTimer = setTimeout(() => finish(connected ? { kind: "no-answer" } : { kind: "no-connection", detail: `no connection to ${socketPath}` }), answerLimitMs);
    const markConnected = () => {
      connected = true;
      clearTimeout(connectTimer);
    };
    outgoing.on("socket", (socket) => {
      if (socket.connecting) socket.once("connect", markConnected);
      else markConnected();
    });
    outgoing.on("error", (error) =>
      finish(
        connected
          ? { kind: "dropped", detail: `${socketPath} closed the connection before answering: ${error.message}` }
          : { kind: "no-connection", detail: `no connection to ${socketPath}: ${error.message}` },
      ),
    );
    outgoing.on("response", (incoming) => {
      const pieces: Buffer[] = [];
      incoming.on("data", (piece: Buffer) => pieces.push(piece));
      incoming.on("end", () => finish({ kind: "answered", body: Buffer.concat(pieces).toString("utf8") }));
      incoming.on("error", (error) => finish({ kind: "dropped", detail: `${socketPath} broke off its answer: ${error.message}` }));
    });
    outgoing.end(body);
  });
}

export async function agentAlive(socketPath: string | undefined, paneId: string): Promise<AliveAnswer | undefined> {
  if (socketPath === undefined) return undefined;
  const exchange = await exchangeOverSocket(socketPath, "GET", ALIVE_PATH, undefined, ALIVE_TIMEOUT_MILLISECONDS);
  if (exchange.kind !== "answered") return undefined;
  try {
    const alive = JSON.parse(exchange.body) as AliveAnswer;
    return alive.pane === paneId ? alive : undefined;
  } catch {
    return undefined;
  }
}

function readAnswer(body: string): Partial<DeliveryAnswer> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<DeliveryAnswer>) : undefined;
  } catch {
    return undefined;
  }
}

export const ACKNOWLEDGED_ANSWER_LIMIT_MILLISECONDS = 1500;
export const ACKNOWLEDGED_ATTEMPTS = 3;

async function takesAcknowledgedDelivery(socketPath: string, paneId: string): Promise<boolean> {
  return (await agentAlive(socketPath, paneId))?.callbacks === true;
}

async function askUntilAnswered(socketPath: string, body: string): Promise<Exchange> {
  let exchange: Exchange = { kind: "no-answer" };
  for (let attempt = 1; attempt <= ACKNOWLEDGED_ATTEMPTS; attempt += 1) {
    exchange = await exchangeOverSocket(socketPath, "POST", DELIVER_PATH, body, ACKNOWLEDGED_ANSWER_LIMIT_MILLISECONDS);
    if (exchange.kind === "answered" || exchange.kind === "no-connection") return exchange;
  }
  return exchange;
}

export async function deliverThroughExtension(
  content: string | HarnessCommandRequest,
  timeoutMs: number,
  recipientPaneId: string,
  deps: ExtensionDeliveryDeps = {},
): Promise<ExtensionDeliveryOutcome> {
  if (recipientPaneId.trim() === "") {
    return { kind: "refused", detail: "delivery requires a recipient pane id; refusing to broadcast" };
  }
  if (deps.socketPath === undefined) {
    return { kind: "not-answering", detail: "no delivery socket is recorded for the recipient" };
  }
  const isCommand = typeof content !== "string";
  const id = deps.requestId ?? `${isCommand ? COMMAND_ID_PREFIX : MESSAGE_ID_PREFIX}${randomUUID()}`;
  const acknowledged = !isCommand && (await takesAcknowledgedDelivery(deps.socketPath, recipientPaneId));
  const request: DeliveryRequest = isCommand
    ? { id, pane: recipientPaneId, command: content.command, args: content.args, waitMs: timeoutMs }
    : { id, pane: recipientPaneId, text: content, waitMs: timeoutMs, ...(acknowledged ? { acknowledge: true as const } : {}) };
  const started = Date.now();
  const exchange = acknowledged
    ? await askUntilAnswered(deps.socketPath, JSON.stringify(request))
    : await exchangeOverSocket(deps.socketPath, "POST", DELIVER_PATH, JSON.stringify(request), timeoutMs + SENDER_MARGIN_MILLISECONDS);
  if (exchange.kind === "no-connection") return { kind: "not-answering", detail: exchange.detail };
  if (exchange.kind === "no-answer") return { kind: "timed-out", waitedMs: Date.now() - started };
  if (exchange.kind === "dropped") return { kind: "dropped", detail: exchange.detail };
  const answer = readAnswer(exchange.body);
  if (answer === undefined) return { kind: "refused", detail: "unparseable answer from the delivery socket" };
  if (answer.id !== id || answer.pane !== recipientPaneId) {
    return {
      kind: "refused",
      detail: `delivery answer identified request "${String(answer.id)}" on pane "${String(answer.pane)}", not "${id}" on recipient pane "${recipientPaneId}"`,
    };
  }
  if (answer.status === "delivered") return { kind: "delivered" };
  if (answer.status === "accepted") return { kind: "accepted" };
  if (answer.status === "busy") return { kind: "timed-out", waitedMs: Date.now() - started };
  if (answer.status === "refused") return { kind: "refused", detail: answer.detail ?? "refused without a reason" };
  return { kind: "refused", detail: `delivery socket answered "${String(answer.status)}"` };
}
