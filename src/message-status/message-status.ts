import {
  MessageQueueStore,
  MessageQueueWorkItemState,
  openMessageQueueStore,
} from "../message-queue/message-queue.store.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

/**
 * How stale the server's last heartbeat may be before a `queued`/`in-flight`
 * verdict must say so rather than reading as healthy. The throne-work server
 * writes a heartbeat on every dispatch-loop poll cycle; this bound is a small
 * multiple of a plausible poll interval, not a measured one, so it flags a
 * dead or wedged loop without flapping on ordinary scheduling jitter.
 */
export const MESSAGE_STATUS_HEARTBEAT_STALE_THRESHOLD_MS = 30_000;

export const MessageStatusVerdict = {
  UnknownId: "unknown-id",
  Queued: "queued",
  Scheduled: "scheduled",
  Cancelled: "cancelled",
  InFlight: "in-flight",
  Delivered: "delivered",
  FailedWithReason: "failed-with-reason",
} as const;

export type MessageStatusVerdict =
  (typeof MessageStatusVerdict)[keyof typeof MessageStatusVerdict];

export interface HeartbeatStaleness {
  readonly isStale: boolean;
  /** `undefined` when the server has never written a heartbeat at all. */
  readonly ageMs: number | undefined;
}

export interface MessageStatusResult {
  readonly verdict: MessageStatusVerdict;
  readonly dueAt?: string;
  readonly failureReason?: string;
  readonly heartbeatStaleness?: HeartbeatStaleness;
}

const NON_TERMINAL_STATE_TO_VERDICT: ReadonlyMap<
  MessageQueueWorkItemState,
  MessageStatusVerdict
> = new Map([
  [MessageQueueWorkItemState.Queued, MessageStatusVerdict.Queued],
  [MessageQueueWorkItemState.InFlight, MessageStatusVerdict.InFlight],
]);

export function classifyHeartbeatStaleness(
  heartbeatTimestamp: number | undefined,
  now: number,
  staleThresholdMs: number = MESSAGE_STATUS_HEARTBEAT_STALE_THRESHOLD_MS,
): HeartbeatStaleness {
  if (heartbeatTimestamp === undefined) {
    return { isStale: true, ageMs: undefined };
  }
  const ageMs = now - heartbeatTimestamp;
  return { isStale: ageMs > staleThresholdMs, ageMs };
}

/**
 * Reads a work item's typed delivery status, read-only. `delivered` is
 * reported exactly when the stored row's state already is the terminal
 * `delivered` state the throne-work server writes after a confirmed send —
 * this function infers nothing about delivery itself.
 */
export function readMessageStatus(
  store: MessageQueueStore,
  id: number,
  now: () => number = Date.now,
): MessageStatusResult {
  const row = store.readWorkItem(id);
  if (row === undefined) {
    return { verdict: MessageStatusVerdict.UnknownId };
  }
  if (row.state === MessageQueueWorkItemState.Delivered) {
    return { verdict: MessageStatusVerdict.Delivered };
  }
  if (row.state === MessageQueueWorkItemState.Failed) {
    return {
      verdict: MessageStatusVerdict.FailedWithReason,
      failureReason: row.failureReason ?? "",
    };
  }
  if (row.state === MessageQueueWorkItemState.Cancelled) {
    return { verdict: MessageStatusVerdict.Cancelled };
  }
  if (row.state === MessageQueueWorkItemState.Queued && row.dueAt !== null) {
    return { verdict: MessageStatusVerdict.Scheduled, dueAt: new Date(row.dueAt).toISOString() };
  }
  const verdict = NON_TERMINAL_STATE_TO_VERDICT.get(row.state)!;
  const heartbeatStaleness = classifyHeartbeatStaleness(
    store.readHeartbeat(),
    now(),
  );
  return { verdict, heartbeatStaleness };
}


function describeHeartbeatStaleness(staleness: HeartbeatStaleness): string {
  if (!staleness.isStale) {
    return "";
  }
  if (staleness.ageMs === undefined) {
    return " — server heartbeat has never been recorded";
  }
  return ` — server heartbeat stale, ${Math.floor(staleness.ageMs / 1000)}s ago`;
}

export function formatMessageStatusOutput(
  id: number | string,
  result: MessageStatusResult,
): string {
  switch (result.verdict) {
    case MessageStatusVerdict.UnknownId:
      return `message-status: no such message id ${id}\n`;
    case MessageStatusVerdict.Delivered:
      return "delivered\n";
    case MessageStatusVerdict.Cancelled:
      return "cancelled\n";
    case MessageStatusVerdict.Scheduled:
      return `scheduled — due ${result.dueAt}\n`;
    case MessageStatusVerdict.FailedWithReason:
      return `failed: ${result.failureReason}\n`;
    case MessageStatusVerdict.Queued:
    case MessageStatusVerdict.InFlight:
      return result.heartbeatStaleness === undefined
        ? `${result.verdict}\n`
        : `${result.verdict}${describeHeartbeatStaleness(result.heartbeatStaleness)}\n`;
  }
}

export const MESSAGE_STATUS_EXIT = {
  Success: 0,
  UnknownId: 1,
  Usage: 64,
  TransportUnavailable: 69,
} as const;

/** This command's registered name on the transport route dispatcher. */
export const MESSAGE_STATUS_ROUTE_PATH = "message-status";

export interface MessageStatusRouteResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MessageStatusDeps {
  openStore: () => MessageQueueStore;
  now: () => number;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const REAL_DEPS: MessageStatusDeps = {
  openStore: openMessageQueueStore,
  now: Date.now,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

type MessageStatusDispatch =
  | { readonly kind: "sqlite"; readonly id: number }
  | { readonly kind: "usage" };

function resolveMessageStatusDispatch(
  args: readonly string[],
): MessageStatusDispatch {
  if (args.length !== 1 || args[0] === undefined) {
    return { kind: "usage" };
  }
  const id = Number(args[0]);
  return Number.isInteger(id) && id > 0
    ? { kind: "sqlite", id }
    : { kind: "usage" };
}

export async function runMessageStatus(
  args: readonly string[],
  deps: MessageStatusDeps = REAL_DEPS,
): Promise<number> {
  const dispatch = resolveMessageStatusDispatch(args);

  if (dispatch.kind === "usage") {
    deps.stderr(
      "message-status: exactly one positive integer message id is required. " +
        "Usage: ./bin/throne-cli message-status <id>\n",
    );
    deps.stderr(
      `${renderEntranceRefusal({
        reason: "message-status entrance validation requires exactly one positive message id.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return MESSAGE_STATUS_EXIT.Usage;
  }


  const store = deps.openStore();
  try {
    const result = readMessageStatus(store, dispatch.id, deps.now);
    deps.stdout(formatMessageStatusOutput(dispatch.id, result));
    return result.verdict === MessageStatusVerdict.UnknownId
      ? MESSAGE_STATUS_EXIT.UnknownId
      : MESSAGE_STATUS_EXIT.Success;
  } finally {
    store.close();
  }
}

/**
 * The transport route dispatcher's handler for `message-status`: runs the
 * exact same `runMessageStatus` the in-process command calls, capturing what
 * it would have written to stdout/stderr instead of writing to this
 * process's own streams. `message-status` has no request-scoped path to
 * resolve, so the request envelope's `cwd` is accepted (never read via
 * `process.cwd()`, per the dispatcher's own invariant) and intentionally
 * unused -- its queue lives at a fixed, cwd-independent location.
 */
export async function handleMessageStatusRoute(envelope: {
  readonly args: readonly string[];
}): Promise<MessageStatusRouteResult> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runMessageStatus(envelope.args, {
    ...REAL_DEPS,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}
