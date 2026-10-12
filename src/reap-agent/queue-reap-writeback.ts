import type { ReapReason } from "../agent-timings/reap-reason.ts";
import { findDeliveryCommitHash } from "../git-lifecycle/delivery-commit-proof.ts";
import {
  findInFlightQueueItemByAgentName,
  recordAgentReapOutcomeOnQueueItem,
  type StatedQueueOutcome,
} from "../regent-queue/regent-queue-lifecycle.ts";
import { QueueOutcome } from "../regent-queue/regent-queue-outcome.ts";
import {
  openRegentQueueStore,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import { ReportOutcomeState, readReportOutcome } from "./report-outcome.ts";

export interface QueueReapEvidence {
  readonly deliveryCommit?: string;
  readonly statedOutcome?: StatedQueueOutcome;
}

export interface QueueReapWritebackDeps {
  openStore?: () => RegentQueueStore;
  findDeliveryCommitHash?: typeof findDeliveryCommitHash;
  writeStdout?: (text: string) => void;
  ledgerBaseDir?: string;
  evidenceResolvedBeforeTeardown?: QueueReapEvidence;
}

function stdoutWriter(
  deps: Pick<QueueReapWritebackDeps, "writeStdout">,
): (text: string) => void {
  return deps.writeStdout ?? ((text: string) => process.stdout.write(text));
}

async function resolveQueueReapDeliveryCommit(
  name: string,
  reason: ReapReason,
  deps: Pick<QueueReapWritebackDeps, "findDeliveryCommitHash" | "writeStdout">,
): Promise<string | undefined> {
  if (reason !== "completed") return undefined;
  const resolveDeliveryCommit =
    deps.findDeliveryCommitHash ?? findDeliveryCommitHash;
  try {
    return await resolveDeliveryCommit(name);
  } catch (error) {
    stdoutWriter(deps)(
      `reap-agent: delivery commit lookup failed for "${name}" (${error instanceof Error ? error.message : String(error)}) — queue write-back proceeds without it.\n`,
    );
    return undefined;
  }
}

async function resolveStatedOutcome(
  name: string,
  deps: Pick<QueueReapWritebackDeps, "ledgerBaseDir" | "writeStdout">,
): Promise<StatedQueueOutcome | undefined> {
  const reading = await readReportOutcome(name, deps.ledgerBaseDir);
  if (reading.state === ReportOutcomeState.Invalid) {
    stdoutWriter(deps)(
      `reap-agent: REPORT.md for "${name}" states outcome "${reading.statedValue}", which is not one of ${Object.values(QueueOutcome).join(", ")} — the queue row's outcome is not taken from the report.\n`,
    );
  }
  return reading.state === ReportOutcomeState.Stated
    ? reading.statedOutcome
    : undefined;
}

export async function resolveQueueReapEvidence(
  name: string,
  reason: ReapReason,
  deps: Pick<
    QueueReapWritebackDeps,
    "findDeliveryCommitHash" | "writeStdout" | "ledgerBaseDir"
  > = {},
): Promise<QueueReapEvidence> {
  return {
    deliveryCommit: await resolveQueueReapDeliveryCommit(name, reason, deps),
    statedOutcome: await resolveStatedOutcome(name, deps),
  };
}

/**
 * `reap-agent`'s side of the shared queue lifecycle write-back
 * (`regent-queue-lifecycle.ts`): looks the queue item up by the agent name
 * a prior `create-agent` launch recorded on it (never by re-deriving an
 * objective code from the agent name — see this slice's execution log),
 * then applies the reap-reason mapping (`completed` -> `complete`,
 * `abandoned` and `force` -> `abandoned`; every other reason is a
 * no-op). Runs AFTER teardown has succeeded — a row must never say
 * `complete` while the agent is still alive because teardown refused (the
 * hiregent lie, 2026-09-02) — so the delivery commit is resolved beforehand
 * by `resolveQueueReapEvidence` and handed in via
 * `deps.evidenceResolvedBeforeTeardown`.
 * Never throws: any failure to match, open the store, or resolve the delivery
 * commit is logged to stdout and swallowed, so the write-back can never fail
 * the reap it rides along with.
 */
export async function writeQueueReapOutcome(
  name: string,
  reason: ReapReason,
  deps: QueueReapWritebackDeps = {},
): Promise<void> {
  const openStore = deps.openStore ?? openRegentQueueStore;
  const writeStdout = stdoutWriter(deps);
  let store: RegentQueueStore | undefined;
  try {
    const evidence =
      deps.evidenceResolvedBeforeTeardown ??
      (await resolveQueueReapEvidence(name, reason, deps));
    store = openStore();
    const outcome = recordAgentReapOutcomeOnQueueItem(store, {
      agentName: name,
      reason,
      ...evidence,
    });
    if (!outcome.matched) {
      writeStdout(
        `reap-agent: queue linkage not recorded for "${name}" — ${outcome.reason}.\n`,
      );
    }
  } catch (error) {
    writeStdout(
      `reap-agent: queue linkage write-back failed for "${name}" (${error instanceof Error ? error.message : String(error)}) — reap proceeds unaffected.\n`,
    );
  } finally {
    store?.close();
  }
}

export interface QueueLinkage {
  readonly itemId: string;
  readonly objectiveCode: string | null;
}

/**
 * Is this agent the recorded launcher of an in-flight queue row? Read-only;
 * never throws — a store that cannot be opened reads as "no linkage", which
 * is the conservative answer for the refusal that consumes it (a scratch reap
 * proceeds, as it always has).
 */
export async function readQueueLinkage(
  name: string,
  deps: Pick<QueueReapWritebackDeps, "openStore"> = {},
): Promise<QueueLinkage | undefined> {
  const openStore = deps.openStore ?? openRegentQueueStore;
  let store: RegentQueueStore | undefined;
  try {
    store = openStore();
    const item = findInFlightQueueItemByAgentName(store, name);
    return item === undefined
      ? undefined
      : { itemId: item.id, objectiveCode: item.objectiveCode };
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}
