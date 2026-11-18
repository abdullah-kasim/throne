import {
  DELIVERY_SOCKET_ENV,
  MOD_REPORT_TIMEOUT_MILLISECONDS,
  type BusyReason,
  type DeliveredAs,
  type DeliveryRequest,
} from "../shared/agent-delivery-contract.ts";
import { startDeliveryListener, type SubmitAttempt } from "../shared/agent-delivery-listener.ts";

const DELIVERED_AS: readonly DeliveredAs[] = ["turn", "followUp"];
const BUSY_REASONS: readonly BusyReason[] = ["draft", "turn-running", "composer-unreadable"];

type ModReport = { id: string; attempt: SubmitAttempt };

function readModReport(body: string): ModReport | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed?.id !== "string") return null;
  if (parsed.status === "delivered" && DELIVERED_AS.includes(parsed.as as DeliveredAs)) {
    return { id: parsed.id, attempt: { status: "delivered", as: parsed.as as DeliveredAs } };
  }
  if (parsed.status === "not-yet" && BUSY_REASONS.includes(parsed.reason as BusyReason)) {
    return { id: parsed.id, attempt: { status: "not-yet", reason: parsed.reason as BusyReason } };
  }
  if (parsed.status === "refused" && typeof parsed.detail === "string") {
    return { id: parsed.id, attempt: { status: "refused", detail: parsed.detail } };
  }
  return null;
}

function printLine(line: object): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function lineFor(request: DeliveryRequest): object {
  if ("command" in request) return { id: request.id, command: request.command, args: request.args };
  return { id: request.id, text: request.text };
}

const waiting = new Map<string, (attempt: SubmitAttempt) => void>();

function askMod(request: DeliveryRequest, withdrawn: AbortSignal): Promise<SubmitAttempt> {
  return new Promise((resolve) => {
    const finish = (attempt: SubmitAttempt) => {
      clearTimeout(timer);
      withdrawn.removeEventListener("abort", withdraw);
      waiting.delete(request.id);
      resolve(attempt);
    };
    const withdraw = () => {
      printLine({ withdrawn: request.id });
      finish({ status: "not-yet", reason: "composer-unreadable" });
    };
    const timer = setTimeout(withdraw, MOD_REPORT_TIMEOUT_MILLISECONDS);
    withdrawn.addEventListener("abort", withdraw, { once: true });
    waiting.set(request.id, finish);
    printLine(lineFor(request));
  });
}

function takeModReport(body: string): boolean {
  const report = readModReport(body);
  if (report === null) return false;
  waiting.get(report.id)?.(report.attempt);
  return true;
}

const socketPath = process.env[DELIVERY_SOCKET_ENV];
const pane = process.env.HERDR_PANE_ID;
if (!socketPath || !pane) {
  process.stderr.write(`${DELIVERY_SOCKET_ENV} and HERDR_PANE_ID must be set\n`);
  process.exit(1);
}

await startDeliveryListener({ socketPath, pane, harness: "claude", commands: true, tryDeliver: askMod, takeReport: takeModReport });
printLine({ listening: true });
