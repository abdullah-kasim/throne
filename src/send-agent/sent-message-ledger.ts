import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";

const LEDGER_FILE_NAME = "sent-messages.jsonl";

export type SentMessageTransport = "sqlite";

export interface SentMessageLedgerEntry {
  readonly senderName: string;
  readonly recipientName: string;
  readonly id: string;
  readonly transport: SentMessageTransport;
  readonly sentAtMs: number;
}

export function sentMessageLedgerPath(
  senderName: string,
  baseDir: string = RUNTIME_DATA_DIR,
): string {
  return path.join(baseDir, senderName, LEDGER_FILE_NAME);
}

/**
 * Appends one JSON line recording an accepted `send-agent` delivery to the
 * sender's durable per-agent ledger — the mechanism that makes the id
 * recoverable after the fact even when the caller discarded stdout. Creates
 * the sender's ledger directory if this is its first recorded send.
 * Append-only: never reads, rewrites, or truncates the file.
 */
export async function appendSentMessageLedgerEntry(
  entry: SentMessageLedgerEntry,
  baseDir: string = RUNTIME_DATA_DIR,
): Promise<void> {
  const filePath = sentMessageLedgerPath(entry.senderName, baseDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  const record = {
    timestamp: new Date(entry.sentAtMs).toISOString(),
    recipient: entry.recipientName,
    id: entry.id,
    transport: entry.transport,
  };
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}
