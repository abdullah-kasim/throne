import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import {
  openRegentQueueStore,
  RegentQueueItemStatus,
  type EligibleQueueLaunchMetadata,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import { queueAddressingObjectiveCode } from "../shared-policy/objective-contract.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const VALUE_FLAGS = new Map<string, keyof MarkQueueLaunchEligibleInput>([
  ["--objective-code", "objectiveCode"],
  ["--alpha-name", "alphaName"],
  ["--target-repo", "targetRepo"],
  ["--target-branch", "targetBranch"],
  ["--base-commit", "baseCommit"],
]);

export interface MarkQueueLaunchEligibleInput extends EligibleQueueLaunchMetadata {
  readonly objectiveCode: string;
}

export function parseMarkQueueLaunchEligibleArgs(
  args: string[],
): MarkQueueLaunchEligibleInput {
  const parsed: Partial<Record<keyof MarkQueueLaunchEligibleInput, string>> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    const field = VALUE_FLAGS.get(flag);
    if (field === undefined) {
      throw new Error(`mark-queue-launch-eligible: unknown argument "${flag}"`);
    }
    const value = args[++index];
    if (value === undefined || value.trim() === "") {
      throw new Error(`mark-queue-launch-eligible: ${flag} requires a value`);
    }
    parsed[field] = value;
  }
  const objectiveCode = queueAddressingObjectiveCode(parsed.objectiveCode ?? "");
  if (objectiveCode === undefined) {
    throw new Error("mark-queue-launch-eligible: a valid --objective-code is required");
  }
  const missingFlags = [...VALUE_FLAGS]
    .filter(([flag, field]) => flag !== "--objective-code" && parsed[field] === undefined)
    .map(([flag]) => flag);
  if (missingFlags.length > 0) {
    throw new Error(
      `mark-queue-launch-eligible: required ${missingFlags.join(", ")}`,
    );
  }
  return {
    objectiveCode,
    alphaName: parsed.alphaName!,
    targetRepo: parsed.targetRepo!,
    targetBranch: parsed.targetBranch!,
    baseCommit: parsed.baseCommit!,
  };
}

export function markQueueItemLaunchEligible(
  store: RegentQueueStore,
  input: MarkQueueLaunchEligibleInput,
) {
  const item = findQueueItemByObjectiveCode(store, input.objectiveCode);
  if (item === undefined) {
    throw new Error(`queue objective "${input.objectiveCode}" does not exist`);
  }
  if (item.status !== RegentQueueItemStatus.Open) {
    throw new Error(
      `queue objective "${input.objectiveCode}" is "${item.status}", not "open"`,
    );
  }
  return store.markLaunchEligible(item.id, input);
}

export async function run(
  args: string[],
  openStore: () => RegentQueueStore = openRegentQueueStore,
): Promise<number> {
  let store: RegentQueueStore | undefined;
  try {
    const input = parseMarkQueueLaunchEligibleArgs(args);
    store = openStore();
    const item = markQueueItemLaunchEligible(store, input);
    process.stdout.write(
      `mark-queue-launch-eligible: marked "${item.objectiveCode}" launch-eligible.\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (store === undefined) {
      process.stderr.write(
        `${renderEntranceRefusal({
          reason: "mark-queue-launch-eligible entrance validation rejected the supplied launch facts.",
          bypass: undefined,
          supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
        })}\n`,
      );
    }
    return 1;
  } finally {
    store?.close();
  }
}
