import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatFileLine } from "./file-line.ts";
import type { Finding } from "./push-waiver-findings.ts";
import type { WaivedFinding } from "./push-waiver-entries.ts";

export const PUSH_WAIVERS_DIRECTORY = "push-waivers";

export interface WaiverKey {
  readonly remote: string;
  readonly ref: string;
  readonly commit: string;
}

export interface WaiverRecord extends WaiverKey {
  readonly agent: string;
  readonly repo: string;
  readonly writtenAt: string;
  readonly findings: readonly Finding[];
  readonly entries: readonly WaivedFinding["entry"][];
}

export function unspentWaiverPath(ledger: string, key: WaiverKey): string {
  return path.join(ledger, PUSH_WAIVERS_DIRECTORY, key.remote, key.ref, `${key.commit}.json`);
}

function serializeRecord(record: WaiverRecord): string {
  const entries = record.entries.map((entry) => ("location" in entry ? { ...entry, location: formatFileLine(entry.location) } : entry));
  return `${JSON.stringify({ ...record, entries }, null, 2)}\n`;
}

export async function writeWaiverRecord(ledger: string, record: WaiverRecord): Promise<string> {
  const recordPath = unspentWaiverPath(ledger, record);
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, serializeRecord(record), "utf8");
  return recordPath;
}
