// Rebuilt on the SQLite-backed Regent queue store (see `regent-queue.store.ts`)
// — no more markdown block surgery. Safe by default: a dry run (the default)
// reports which terminal items a real trim would remove; `--apply` performs
// the removal. A non-terminal item (open/in-flight) is never removable
// regardless of flags — decided by `TERMINAL_QUEUE_ITEM_STATUSES`, the one
// place `TERMINAL_QUEUE_ITEM_STATUSES` (see `regent-queue.store.ts` /
// `regent-queue-item-state.ts`) defines "terminal", never reimplemented here.

import {
  openRegentQueueStore,
  type RegentQueueItemRow,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import { TERMINAL_QUEUE_ITEM_STATUSES } from "../regent-queue/regent-queue-item-state.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const APPLY_FLAG = "--apply";
const ACTOR_FLAG = "--actor";

export interface TrimQueueDeps {
  openStore: () => RegentQueueStore;
}

type TrimMode = { apply: false } | { apply: true; actor: string };

export const REAL_DEPS: TrimQueueDeps = {
  openStore: openRegentQueueStore,
};

function isTerminal(item: RegentQueueItemRow): boolean {
  return TERMINAL_QUEUE_ITEM_STATUSES.has(item.status);
}

function describeItem(item: RegentQueueItemRow): string {
  const label = item.objectiveCode ?? item.id;
  return `"${label}" (${item.status}): ${item.body}`;
}

function readActor(args: string[]): string | undefined {
  const index = args.indexOf(ACTOR_FLAG);
  return index === -1 ? undefined : args[index + 1]?.trim() || undefined;
}

function entranceRefusal(reason: string): number {
  process.stderr.write(
    `${reason}\n${renderEntranceRefusal({
      reason: "trim-queue entrance validation rejected this invocation.",
      bypass: undefined,
      supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
    })}\n`,
  );
  return 1;
}

export async function run(
  args: string[],
  deps: TrimQueueDeps = REAL_DEPS,
): Promise<number> {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === APPLY_FLAG) continue;
    if (argument === ACTOR_FLAG) {
      if (args[index + 1] === undefined || args[index + 1]!.startsWith("--")) {
        return entranceRefusal(`trim-queue: ${ACTOR_FLAG} requires a value.`);
      }
      index++;
      continue;
    }
    return entranceRefusal(`trim-queue: unknown argument "${argument}"`);
  }
  if (args.filter((argument) => argument === APPLY_FLAG).length > 1) {
    return entranceRefusal(`trim-queue: ${APPLY_FLAG} may be specified only once`);
  }
  if (args.filter((argument) => argument === ACTOR_FLAG).length > 1) {
    return entranceRefusal(`trim-queue: ${ACTOR_FLAG} may be specified only once`);
  }
  const apply = args.includes(APPLY_FLAG);
  const actor = readActor(args);
  let mode: TrimMode = { apply: false };

  if (apply) {
    if (actor === undefined) {
      process.stderr.write(
        `trim-queue: ${APPLY_FLAG} requires an explicit ${ACTOR_FLAG} value.\n${renderEntranceRefusal({
          reason: "trim-queue entrance validation requires --actor for an archival mutation.",
          bypass: undefined,
          supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
        })}\n`,
      );
      return 1;
    }
    mode = { apply: true, actor };
  }

  const store = deps.openStore();
  try {
    const result = store.readAll();
    if (result.state === "unknown") {
      process.stderr.write(
        `trim-queue: could not read the queue store (${result.reason}).\n`,
      );
      return 1;
    }
    if (result.state === "positively-empty") {
      process.stdout.write(
        "trim-queue: nothing to trim — the queue store is empty.\n",
      );
      return 0;
    }

    const removable = result.items.filter(isTerminal);
    if (removable.length === 0) {
      process.stdout.write(
        "trim-queue: nothing to trim — no terminal (complete/abandoned) items.\n",
      );
      return 0;
    }

    if (!mode.apply) {
      const lines = [
        `trim-queue: dry run — ${removable.length} terminal item(s) would be archived ` +
          `(pass ${APPLY_FLAG} to archive them):`,
        ...removable.map((item) => `  - ${describeItem(item)}`),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }

    const archiveResult = store.archiveItems({
      actor: mode.actor,
      predicate: "terminal items selected by trim-queue --apply",
      itemIds: removable.map((item) => item.id),
    });
    process.stdout.write(
      `trim-queue: archived ${archiveResult.rowCount} terminal item(s) (operation ${archiveResult.operationId}).\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}
