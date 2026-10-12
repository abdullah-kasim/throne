import type { DatabaseSync } from "node:sqlite";

export function runInImmediateTransaction<Result>(
  db: DatabaseSync,
  work: () => Result,
): Result {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    rollBackIgnoringFailure(db);
    throw error;
  }
}

function rollBackIgnoringFailure(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    return;
  }
}

function isDedupeKeyStoredInAnyState(
  db: DatabaseSync,
  kind: string,
  dedupeKey: string,
): boolean {
  const storedRow = db
    .prepare(`SELECT 1 FROM work_items WHERE kind = ? AND dedupe_key = ? LIMIT 1`)
    .get(kind, dedupeKey);
  return storedRow !== undefined;
}

export function insertUnlessDedupeKeyIsStored<Row>(
  db: DatabaseSync,
  kind: string,
  dedupeKey: string,
  insert: () => Row,
): Row | undefined {
  return runInImmediateTransaction(db, () =>
    isDedupeKeyStoredInAnyState(db, kind, dedupeKey) ? undefined : insert(),
  );
}
