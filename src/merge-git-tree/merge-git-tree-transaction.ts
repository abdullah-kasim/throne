import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { acquireAtomicMkdirLock } from "../alpha-monitoring/atomic-mkdir-lock.ts";
import {
  openRegentQueueStore,
  resolveRegentQueueDatabasePath,
} from "../regent-queue/regent-queue.store.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";

const execFileAsync = promisify(execFile);
export const TARGET_DELIVERY_LOCK_TTL_MS = 60_000;

export async function withTargetDeliveryLock<T>(
  targetRepo: string,
  holder: string,
  dataDir: string | undefined,
  operation: () => Promise<T>,
  log: (message: string) => void,
): Promise<T> {
  const canonicalTarget = await realpath(targetRepo);
  const key = createHash("sha256").update(canonicalTarget).digest("hex");
  const release = await acquireAtomicMkdirLock({
    lockPath: path.join(
      dataDir ?? RUNTIME_DATA_DIR,
      ".runtime",
      "target-delivery-locks",
      `${key}.lock`,
    ),
    holder,
    staleAfterMs: TARGET_DELIVERY_LOCK_TTL_MS,
    attempts: TARGET_DELIVERY_LOCK_TTL_MS / 10 + 100,
    log,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

/**
 * Marks the absorbing agent's queue objective as needing a validation Alpha.
 *
 * A MISSING `objective_code` IS NOT-APPLICABLE, NOT AN ERROR. This threw
 * until 2026-08-25 and the throw was a hard deadlock: a non-campaign agent —
 * a Stager, a canary, any infrastructure worker — correctly has no
 * objective_code, so the moment its branch absorbed target content it could
 * never deliver at all. The first agent to hit it was a Stager whose branch
 * absorbed main mid-flight, and the trap is self-closing: the fix lives in
 * throne source, which that agent could not merge precisely because of the
 * bug it was trying to fix.
 *
 * The distinction the throw collapsed is "this delivery needs no queue
 * bookkeeping" versus "this delivery is impossible". There is no queue row to
 * mark because there is no campaign — nothing to persist is the correct
 * outcome, not a failure.
 *
 * The NOTIFICATION deliberately still fires for these agents (see the caller
 * in `merge-git-tree-runtime.ts`): the absorb genuinely happened and a human
 * should still hear that new target content went out undelivered-through-a-
 * gate. Only the row write is inapplicable.
 */
export async function markDeliveryValidationRequired(
  name: string,
  dataDir: string | undefined,
): Promise<void> {
  const spawn = await readSpawnSpec(name, dataDir);
  if (spawn?.objective_code === undefined) return;
  const store = openRegentQueueStore(
    resolveRegentQueueDatabasePath(dataDir ?? RUNTIME_DATA_DIR),
  );
  try {
    store.markValidationRequired(spawn.objective_code);
  } finally {
    store.close();
  }
}

export async function notifyDeliveryValidationRequired(
  name: string,
): Promise<void> {
  await execFileAsync("throne", [
    "send-agent",
    "Regent",
    `VALIDATION ALPHA required: ${name} absorbed new target content before delivery.`,
  ]);
}
