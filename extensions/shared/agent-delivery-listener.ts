import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ALIVE_PATH,
  BODY_READ_TIMEOUT_MILLISECONDS,
  DELIVER_PATH,
  RESULT_PATH,
  MAX_REQUEST_BYTES,
  REMEMBERED_DELIVERED_IDS,
  RETRY_INTERVAL_MILLISECONDS,
  type AliveAnswer,
  type BusyReason,
  type DeliveredAs,
  type DeliveryAnswer,
  type DeliveryHarness,
  type DeliveryRequest,
} from "./agent-delivery-contract.ts";

export type SubmitAttempt =
  | { status: "delivered"; as: DeliveredAs }
  | { status: "not-yet"; reason: BusyReason }
  | { status: "refused"; detail: string };

export type TryDeliver = (request: DeliveryRequest, withdrawn: AbortSignal) => Promise<SubmitAttempt>;

export type DeliveryListenerOptions = {
  socketPath: string;
  pane: string;
  harness: DeliveryHarness;
  commands: boolean;
  tryDeliver: TryDeliver;
  takeReport?: (body: string) => boolean;
};

export type DeliveryListener = {
  close(): Promise<void>;
};

type BodyResult = { ok: true; body: string } | { ok: false; detail: string };

function readBody(request: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const pieces: Buffer[] = [];
    let size = 0;
    const finish = (result: BodyResult) => {
      clearTimeout(timer);
      request.removeAllListeners("data");
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detail: `request body not read within ${BODY_READ_TIMEOUT_MILLISECONDS} ms` }),
      BODY_READ_TIMEOUT_MILLISECONDS,
    );
    request.on("data", (piece: Buffer) => {
      size += piece.length;
      if (size > MAX_REQUEST_BYTES) {
        finish({ ok: false, detail: `request body over ${MAX_REQUEST_BYTES} bytes` });
        return;
      }
      pieces.push(piece);
    });
    request.on("end", () => finish({ ok: true, body: Buffer.concat(pieces).toString("utf8") }));
    request.on("error", () => finish({ ok: false, detail: "request body could not be read" }));
  });
}

function parseRequest(body: string): DeliveryRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const common =
    typeof record.id === "string" &&
    record.id !== "" &&
    typeof record.pane === "string" &&
    typeof record.waitMs === "number" &&
    Number.isFinite(record.waitMs) &&
    record.waitMs >= 0;
  if (!common) return null;
  if (typeof record.text === "string") return record as unknown as DeliveryRequest;
  if (typeof record.command === "string" && typeof record.args === "string") return record as unknown as DeliveryRequest;
  return null;
}

function idOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed?.id === "string" ? parsed.id : "";
  } catch {
    return "";
  }
}

function answer(response: ServerResponse, body: DeliveryAnswer | AliveAnswer): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(200, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify(body));
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function startDeliveryListener(options: DeliveryListenerOptions): Promise<DeliveryListener> {
  const deliveredIds = new Map<string, DeliveredAs>();
  const rememberDelivered = (id: string, as: DeliveredAs) => {
    deliveredIds.set(id, as);
    while (deliveredIds.size > REMEMBERED_DELIVERED_IDS) {
      deliveredIds.delete(deliveredIds.keys().next().value as string);
    }
  };

  const holdUntilSubmitted = async (request: DeliveryRequest, response: ServerResponse): Promise<DeliveryAnswer | null> => {
    const withdrawal = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) withdrawal.abort();
    });
    const deadline = Date.now() + request.waitMs;
    const deadlineTimer = setTimeout(() => withdrawal.abort(), request.waitMs);
    const answerBase = { id: request.id, pane: options.pane };
    let lastReason: BusyReason = "composer-unreadable";
    try {
      for (;;) {
        const attempt = await Promise.race([
          options.tryDeliver(request, withdrawal.signal),
          new Promise<null>((resolve) => {
            if (withdrawal.signal.aborted) resolve(null);
            withdrawal.signal.addEventListener("abort", () => resolve(null), { once: true });
          }),
        ]);
        if (attempt === null) break;
        if (attempt.status === "delivered") {
          rememberDelivered(request.id, attempt.as);
          return { ...answerBase, status: "delivered", as: attempt.as };
        }
        if (attempt.status === "refused") return { ...answerBase, status: "refused", detail: attempt.detail };
        lastReason = attempt.reason;
        if (Date.now() + RETRY_INTERVAL_MILLISECONDS > deadline) break;
        await wait(RETRY_INTERVAL_MILLISECONDS, withdrawal.signal);
        if (withdrawal.signal.aborted) break;
      }
    } finally {
      clearTimeout(deadlineTimer);
      withdrawal.abort();
    }
    if (response.destroyed || response.writableEnded) return null;
    return { ...answerBase, status: "busy", reason: lastReason };
  };

  const handleDeliver = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    if (!body.ok) {
      answer(response, { id: "", pane: options.pane, status: "refused", detail: body.detail });
      return;
    }
    const delivery = parseRequest(body.body);
    if (delivery === null) {
      answer(response, { id: idOf(body.body), pane: options.pane, status: "refused", detail: "malformed delivery request" });
      return;
    }
    if (delivery.pane !== options.pane) {
      answer(response, {
        id: delivery.id,
        pane: options.pane,
        status: "refused",
        detail: `request for pane ${delivery.pane} reached pane ${options.pane}`,
      });
      return;
    }
    const alreadyDelivered = deliveredIds.get(delivery.id);
    if (alreadyDelivered !== undefined) {
      answer(response, { id: delivery.id, pane: options.pane, status: "delivered", as: alreadyDelivered, repeat: true });
      return;
    }
    const result = await holdUntilSubmitted(delivery, response);
    if (result !== null) answer(response, result);
  };

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === ALIVE_PATH) {
      answer(response, { pane: options.pane, harness: options.harness, commands: options.commands });
      return;
    }
    if (request.method === "POST" && request.url === DELIVER_PATH) {
      void handleDeliver(request, response);
      return;
    }
    const takeReport = options.takeReport;
    if (takeReport !== undefined && request.method === "POST" && request.url === RESULT_PATH) {
      void (async () => {
        const body = await readBody(request);
        response.writeHead(body.ok && takeReport(body.body) ? 200 : 400, { connection: "close" });
        response.end();
      })();
      return;
    }
    response.writeHead(404, { connection: "close" });
    response.end();
  });

  await rm(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
