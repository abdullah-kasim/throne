import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import type { WorkItemRow } from "./message-queue.store.ts";

export const SANDBOX_HARD_KILL_EXIT_CODE = 42;

export interface HardKillTimerHandle {
  readonly armedAtMs: number;
  readonly fireAtMs: number;
  clear(): void;
}

interface SqliteDeliveryPayload {
  readonly recipientName: string;
  readonly senderName: string;
  readonly prompt: string;
  readonly key?: string;
  readonly omitSenderAttribution?: boolean;
  readonly waitForStartupQuiescence?: boolean;
  readonly disableFileBackedDelivery?: boolean;
  readonly accumulatedWaitMs?: number;
}

interface SqliteDeliverySandboxDeps {
  readonly laneBoundMs: number;
  readonly resolveAgent: (name: string) => Promise<HerdrAgent>;
  readonly probeComposerCleared?: (
    agent: HerdrAgent,
    options: {
      composerWaitMilliseconds: number;
      key?: string;
      omitSenderAttribution?: boolean;
      waitForStartupQuiescence?: boolean;
      disableFileBackedDelivery?: boolean;
    },
  ) => Promise<boolean>;
  readonly reschedule: (itemId: number, delayMs: number) => Promise<void>;
  readonly deliver: (item: WorkItemRow, laneBoundMs: number) => Promise<WorkItemRow>;
}

function deliveryPayload(item: WorkItemRow): SqliteDeliveryPayload {
  return item.payload as SqliteDeliveryPayload;
}

function forwardedSubmitOptions(
  payload: SqliteDeliveryPayload,
  composerWaitMilliseconds: number,
): {
  composerWaitMilliseconds: number;
  key?: string;
  omitSenderAttribution?: boolean;
  waitForStartupQuiescence?: boolean;
  disableFileBackedDelivery?: boolean;
} {
  return {
    composerWaitMilliseconds,
    ...(payload.key === undefined ? {} : { key: payload.key }),
    ...(payload.omitSenderAttribution === undefined
      ? {}
      : { omitSenderAttribution: payload.omitSenderAttribution }),
    ...(payload.waitForStartupQuiescence === undefined
      ? {}
      : { waitForStartupQuiescence: payload.waitForStartupQuiescence }),
    ...(payload.disableFileBackedDelivery === undefined
      ? {}
      : { disableFileBackedDelivery: payload.disableFileBackedDelivery }),
  };
}

export function armHardKillTimer(
  hardKillMs: number,
  onFire: () => void = () => process.exit(SANDBOX_HARD_KILL_EXIT_CODE),
): HardKillTimerHandle {
  const armedAtMs = Date.now();
  const timer = setTimeout(onFire, hardKillMs);
  return {
    armedAtMs,
    fireAtMs: armedAtMs + hardKillMs,
    clear: () => clearTimeout(timer),
  };
}

export async function pollAndYieldOrDeliver(
  item: WorkItemRow,
  deps: SqliteDeliverySandboxDeps,
  pollIntervalMs: number,
  minimumDeliveryAttemptFloorMs: number,
): Promise<WorkItemRow | undefined> {
  const payload = deliveryPayload(item);
  const accumulatedWaitMs = payload.accumulatedWaitMs ?? 0;
  const remainingWaitMs = deps.laneBoundMs - accumulatedWaitMs;

  if (remainingWaitMs > 0 && deps.probeComposerCleared !== undefined) {
    const recipient = await deps.resolveAgent(payload.recipientName);
    const cleared = await deps.probeComposerCleared(
      recipient,
      forwardedSubmitOptions(payload, remainingWaitMs),
    );
    if (!cleared) {
      await deps.reschedule(item.id, pollIntervalMs);
      return undefined;
    }
  }

  return deps.deliver(item, Math.max(remainingWaitMs, minimumDeliveryAttemptFloorMs));
}
