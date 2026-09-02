/**
 * Standalone queue worker for cross-process proofs. It either inserts work or
 * claims one due row, so the tests exercise SQLite's process-level locking
 * rather than two handles in one Node process.
 */
import { openMessageQueueStore } from "./message-queue.store.ts";

const [, , databasePath, operation] = process.argv;
if (!databasePath || !operation) {
  throw new Error(
    "usage: message-queue-concurrent-writer.worker.ts <databasePath> <count|claim>",
  );
}

const store = openMessageQueueStore(databasePath);
try {
  if (operation === "claim") {
    const claimed = store.claimNextDueWorkItem();
    process.stdout.write(claimed === undefined ? "" : String(claimed.id));
  } else {
    for (let i = 0; i < Number(operation); i += 1) {
      store.insertWorkItem({ kind: "message-delivery", payload: { i, pid: process.pid } });
    }
  }
} finally {
  store.close();
}
