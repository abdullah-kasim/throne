import type { DatabaseSync } from "node:sqlite";

export function recordWorkItemOutcome(
  db: DatabaseSync,
  id: number,
  outcome: string,
): void {
  db.prepare(
    `UPDATE work_items SET payload = json_set(payload, '$.outcome', ?) WHERE id = ?`,
  ).run(outcome, id);
}

export function workItemOutcome(item: { readonly payload: unknown }): string | undefined {
  const outcome = (item.payload as { outcome?: unknown } | null)?.outcome;
  return typeof outcome === "string" ? outcome : undefined;
}
