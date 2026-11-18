import { Injectable, Optional } from "@nestjs/common";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DELIVERY_CALLBACK_PATH, MAX_REQUEST_BYTES, MESSAGE_ID_PREFIX } from "../../extensions/shared/agent-delivery-contract.ts";
import { scheduleDeliveryReceiptCheck } from "../delivery-receipt/delivery-receipt-check.ts";
import { deliveryCallbackSocketPath } from "../herdr/delivery-socket-path.ts";
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
  type WorkItemRow,
} from "../message-queue/message-queue.store.ts";
import {
  MESSAGE_DELIVERY_WORK_ITEM_KIND,
  type MessageDeliveryWorkItemPayload,
} from "../send-agent/message-delivery-enqueue.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { THRONE_HOME } from "../shared-policy/throne-home.ts";
import type { LongLivedHostedWorker } from "../throne-backend/hosted-worker.types.ts";
import { deliveryCallbackRequest, type DeliveryCallbackRequest } from "../web-api-contract/delivery-callback.ts";

export const DELIVERY_CALLBACK_HOSTED_WORKER_NAME = "delivery-callback";

const OWNER_ONLY = 0o600;
const STOP_CHECK_INTERVAL_MS = 200;

export interface DeliveryCallbackDependencies {
  readonly socketPath: string;
  readonly openStore: () => MessageQueueStore;
  readonly log: (message: string) => void;
}

function productionDependencies(): DeliveryCallbackDependencies {
  return {
    socketPath: deliveryCallbackSocketPath(THRONE_HOME),
    openStore: () => openMessageQueueStore(),
    log: (message) => console.log(`[${DELIVERY_CALLBACK_HOSTED_WORKER_NAME}] ${message}`),
  };
}

class CallbackRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function rowIdOf(callbackId: string): number | undefined {
  if (!callbackId.startsWith(MESSAGE_ID_PREFIX)) return undefined;
  const rowId = Number(callbackId.slice(MESSAGE_ID_PREFIX.length));
  return Number.isInteger(rowId) && rowId > 0 ? rowId : undefined;
}

function acceptedMessageOf(store: MessageQueueStore, report: DeliveryCallbackRequest): WorkItemRow {
  const rowId = rowIdOf(report.id);
  const row = rowId === undefined ? undefined : store.readWorkItem(rowId);
  if (row === undefined || row.kind !== MESSAGE_DELIVERY_WORK_ITEM_KIND || row.state !== MessageQueueWorkItemState.Accepted) {
    throw new CallbackRefused(409, `message ${report.id} is not waiting for a callback`);
  }
  return row;
}

function scheduleReceiptCheckIgnoringFailure(store: MessageQueueStore, delivered: WorkItemRow, typedText: string): void {
  try {
    scheduleDeliveryReceiptCheck(store, delivered, typedText);
  } catch (error) {
    process.stderr.write(`delivery-callback: delivered, but its receipt check could not be scheduled, ignoring: ${errorText(error)}\n`);
  }
}

function settle(store: MessageQueueStore, report: DeliveryCallbackRequest): void {
  const message = acceptedMessageOf(store, report);
  const payload = message.payload as MessageDeliveryWorkItemPayload;
  if (report.pane !== payload.recipientPaneId) {
    throw new CallbackRefused(403, `callback for message ${report.id} came from pane ${report.pane}, not its recipient's`);
  }
  if (report.status === "delivered") {
    const delivered = store.transitionWorkItemState(message.id, MessageQueueWorkItemState.Delivered);
    scheduleReceiptCheckIgnoringFailure(store, delivered, payload.prompt);
    return;
  }
  store.transitionWorkItemState(message.id, MessageQueueWorkItemState.Failed, {
    failureReason: `the agent refused the message: ${report.detail ?? "no reason given"}`,
  });
}

async function readReport(request: IncomingMessage): Promise<DeliveryCallbackRequest> {
  const pieces: Buffer[] = [];
  let size = 0;
  for await (const piece of request as AsyncIterable<Buffer>) {
    size += piece.length;
    if (size > MAX_REQUEST_BYTES) throw new CallbackRefused(400, `callback body over ${MAX_REQUEST_BYTES} bytes`);
    pieces.push(piece);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(pieces).toString("utf8"));
  } catch {
    throw new CallbackRefused(400, "callback body is not JSON");
  }
  const parsed = deliveryCallbackRequest.safeParse(body);
  if (!parsed.success) throw new CallbackRefused(400, "malformed callback");
  return parsed.data;
}

async function receive(openStore: () => MessageQueueStore, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || request.url !== DELIVERY_CALLBACK_PATH) {
    response.writeHead(404, { connection: "close" }).end();
    return;
  }
  try {
    const report = await readReport(request);
    const store = openStore();
    try {
      settle(store, report);
    } finally {
      store.close();
    }
    response.writeHead(204, { connection: "close" }).end();
  } catch (error) {
    const status = error instanceof CallbackRefused ? error.status : 500;
    response.writeHead(status, { "content-type": "text/plain", connection: "close" }).end(errorText(error));
  }
}

export async function startDeliveryCallbackListener(
  socketPath: string,
  openStore: () => MessageQueueStore,
): Promise<Server> {
  const server = createServer((request, response) => void receive(openStore, request, response));
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, OWNER_ONLY);
  return server;
}

@Injectable()
export class DeliveryCallbackHostedWorker implements LongLivedHostedWorker {
  readonly kind = "long-lived" as const;
  readonly workerName = DELIVERY_CALLBACK_HOSTED_WORKER_NAME;

  constructor(@Optional() private readonly dependencies: DeliveryCallbackDependencies = productionDependencies()) {}

  async start(shouldStop: () => boolean): Promise<void> {
    const { socketPath, openStore, log } = this.dependencies;
    let server: Server;
    try {
      server = await startDeliveryCallbackListener(socketPath, openStore);
    } catch (error) {
      log(`not listening on ${socketPath}: ${errorText(error)}`);
      return;
    }
    while (!shouldStop()) {
      await sleep(STOP_CHECK_INTERVAL_MS);
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
