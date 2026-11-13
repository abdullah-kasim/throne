import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "./spawn-data-contracts.ts";

const ACCEPTANCE_BASENAME = "acceptance.json";

export type AcceptanceMethod = "merge" | "verdict";

export type GoAheadSendOutcome = "enqueued" | "failed";

export interface GoAheadRecord {
  sentAt: string;
  sendOutcome: GoAheadSendOutcome;
  messageId?: string;
  error?: string;
}

export interface AcceptanceRecord {
  acceptedAt: string;
  by: string;
  how: AcceptanceMethod;
  goAhead?: GoAheadRecord;
}

export class AcceptanceDataService {
  async read(
    name: string,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<AcceptanceRecord | null> {
    let raw: string;
    try {
      raw = await readFile(path.join(baseDir, name, ACCEPTANCE_BASENAME), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isAcceptanceRecord(parsed)) {
      throw new Error(`${ACCEPTANCE_BASENAME} for ${name} is not an acceptance record`);
    }
    return parsed;
  }

  async write(
    name: string,
    record: AcceptanceRecord,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<void> {
    const dir = path.join(baseDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, ACCEPTANCE_BASENAME),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
}

function isAcceptanceRecord(value: unknown): value is AcceptanceRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.acceptedAt !== "string" || typeof record.by !== "string") return false;
  if (record.how !== "merge" && record.how !== "verdict") return false;
  if (record.goAhead === undefined) return true;
  const goAhead = record.goAhead as Record<string, unknown> | null;
  return (
    typeof goAhead === "object" &&
    goAhead !== null &&
    typeof goAhead.sentAt === "string" &&
    (goAhead.sendOutcome === "enqueued" || goAhead.sendOutcome === "failed")
  );
}

export const ACCEPTANCE_DATA = new AcceptanceDataService();
