import type { ReapReason } from "../agent-timings/reap-reason.ts";
import { findDeliveryCommitHash } from "../git-lifecycle/delivery-commit-proof.ts";
import { recordAgentReapOutcomeOnQueueItem } from "../regent-queue/regent-queue-lifecycle.ts";
import {
  openRegentQueueStore,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";

export interface QueueReapWritebackDeps {
  openStore?: () => RegentQueueStore;
  findDeliveryCommitHash?: typeof findDeliveryCommitHash;
  writeStdout?: (text: string) => void;
}

/**
 * `reap-agent`'s side of the shared queue lifecycle write-back
 * (`regent-queue-lifecycle.ts`): looks the queue item up by the agent name
 * a prior `create-agent` launch recorded on it (never by re-deriving an
 * objective code from the agent name — see this slice's execution log),
 * then applies the reap-reason mapping (`completed` -> `complete`,
 * `cancelled` -> `open`, `force` -> `abandoned`; every other reason is a
 * no-op). Fetches the delivery commit hash only for `completed`, where one
 * may already be available. Never throws: any failure to match, open the
 * store, or resolve the delivery commit is logged to stdout and swallowed,
 * so the write-back can never fail the reap it rides along with.
 */
export async function writeQueueReapOutcome(
  name: string,
  reason: ReapReason,
  deps: QueueReapWritebackDeps = {},
): Promise<void> {
  const openStore = deps.openStore ?? openRegentQueueStore;
  const resolveDeliveryCommit = deps.findDeliveryCommitHash ?? findDeliveryCommitHash;
  const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
  let store: RegentQueueStore | undefined;
  try {
    const deliveryCommit =
      reason === "completed" ? await resolveDeliveryCommit(name) : undefined;
    store = openStore();
    const outcome = recordAgentReapOutcomeOnQueueItem(store, {
      agentName: name,
      reason,
      deliveryCommit,
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
