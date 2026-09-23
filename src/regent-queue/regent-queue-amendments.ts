import type { DatabaseSync } from "node:sqlite";
import {
  openRegentQueueDatabase,
  resolveRegentQueueDatabasePath,
} from "./regent-queue-database.ts";

export interface QueueAmendment {
  readonly objectiveCode: string;
  readonly number: number;
  readonly text: string;
  readonly wordsOf: string;
  readonly relayedBy: string;
  readonly rowStatusWhenRecorded: string;
  readonly recordedAt: number;
}

export interface RecordQueueAmendment {
  readonly objectiveCode: string;
  readonly text: string;
  readonly wordsOf: string;
  readonly relayedBy: string;
}

interface QueueAmendmentSqlRow {
  objective_code: string;
  amendment_number: number;
  amendment_text: string;
  words_of: string;
  relayed_by: string;
  row_status_when_recorded: string;
  recorded_at: number;
}

interface LiveQueueItemReference {
  id: string;
  status: string;
}

const AMENDMENT_COLUMNS =
  "objective_code, amendment_number, amendment_text, words_of, relayed_by, row_status_when_recorded, recorded_at";

function toQueueAmendment(row: QueueAmendmentSqlRow): QueueAmendment {
  return {
    objectiveCode: row.objective_code,
    number: Number(row.amendment_number),
    text: row.amendment_text,
    wordsOf: row.words_of,
    relayedBy: row.relayed_by,
    rowStatusWhenRecorded: row.row_status_when_recorded,
    recordedAt: Number(row.recorded_at),
  };
}

export class RegentQueueAmendments {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  record(input: RecordQueueAmendment): QueueAmendment {
    const item = this.queueItemFor(input.objectiveCode);
    if (item === undefined) {
      throw new Error(`queue objective "${input.objectiveCode}" does not exist`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `INSERT INTO queue_amendments
             (queue_item_id, objective_code, amendment_number, amendment_text, words_of, relayed_by, row_status_when_recorded, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING ${AMENDMENT_COLUMNS}`,
        )
        .get(
          item.id,
          input.objectiveCode,
          this.highestNumberForItem(item.id) + 1,
          input.text,
          input.wordsOf,
          input.relayedBy,
          item.status,
          this.now(),
        ) as unknown as QueueAmendmentSqlRow;
      this.db.exec("COMMIT");
      return toQueueAmendment(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readForObjective(objectiveCode: string): QueueAmendment[] {
    const item = this.queueItemFor(objectiveCode);
    if (item === undefined) return [];
    const rows = this.db
      .prepare(
        `SELECT ${AMENDMENT_COLUMNS} FROM queue_amendments
         WHERE queue_item_id = ? ORDER BY amendment_number ASC`,
      )
      .all(item.id) as unknown as QueueAmendmentSqlRow[];
    return rows.map(toQueueAmendment);
  }

  highestNumberFor(objectiveCode: string): number {
    const item = this.queueItemFor(objectiveCode);
    return item === undefined ? 0 : this.highestNumberForItem(item.id);
  }

  readAllByObjective(): ReadonlyMap<string, readonly QueueAmendment[]> {
    const rows = this.db
      .prepare(
        `SELECT ${AMENDMENT_COLUMNS.split(", ").map((column) => `a.${column}`).join(", ")}
         FROM queue_amendments a JOIN queue_items q ON q.id = a.queue_item_id
         ORDER BY a.objective_code ASC, a.amendment_number ASC`,
      )
      .all() as unknown as QueueAmendmentSqlRow[];
    const byObjective = new Map<string, QueueAmendment[]>();
    for (const amendment of rows.map(toQueueAmendment)) {
      const existing = byObjective.get(amendment.objectiveCode) ?? [];
      existing.push(amendment);
      byObjective.set(amendment.objectiveCode, existing);
    }
    return byObjective;
  }

  close(): void {
    this.db.close();
  }

  private queueItemFor(objectiveCode: string): LiveQueueItemReference | undefined {
    return this.db
      .prepare(`SELECT id, status FROM queue_items WHERE objective_code = ?`)
      .get(objectiveCode) as unknown as LiveQueueItemReference | undefined;
  }

  private highestNumberForItem(queueItemId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(amendment_number), 0) AS highest FROM queue_amendments WHERE queue_item_id = ?`,
      )
      .get(queueItemId) as unknown as { highest: number };
    return Number(row.highest);
  }
}

export function openRegentQueueAmendments(
  databasePath: string = resolveRegentQueueDatabasePath(),
  now: () => number = Date.now,
): RegentQueueAmendments {
  return new RegentQueueAmendments(openRegentQueueDatabase(databasePath), now);
}
