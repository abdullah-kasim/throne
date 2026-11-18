import type { DatabaseSync } from "node:sqlite";

const RECIPIENT = "IFNULL(json_extract(work_items.payload, '$.recipientName'), '')";

export function selectNextDueWorkItemId(
  db: DatabaseSync,
  queuedState: string,
  timestamp: number,
  kinds: readonly string[],
  busyRecipients: ReadonlySet<string> | undefined,
): number | undefined {
  const kindPredicate = kinds.length === 0
    ? ""
    : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
  const busy = busyRecipients === undefined ? [] : [...busyRecipients];
  const lanePredicate = busyRecipients === undefined
    ? ""
    : ` AND ${RECIPIENT} NOT IN (${busy.map(() => "?").join(", ")})
       AND NOT EXISTS (
         SELECT 1 FROM work_items AS earlier
         WHERE earlier.state = ? AND earlier.kind = work_items.kind AND earlier.id < work_items.id
           AND IFNULL(json_extract(earlier.payload, '$.recipientName'), '') = ${RECIPIENT}
       )`;
  const candidate = db.prepare(
    `SELECT id FROM work_items
     WHERE state = ? AND (due_at IS NULL OR due_at <= ?)${kindPredicate}${lanePredicate}
     ORDER BY (due_at IS NOT NULL) ASC, due_at ASC, created_at ASC, id ASC
     LIMIT 1`,
  ).get(
    queuedState,
    timestamp,
    ...kinds,
    ...busy,
    ...(busyRecipients === undefined ? [] : [queuedState]),
  ) as unknown as { id: number } | undefined;
  return candidate?.id;
}
