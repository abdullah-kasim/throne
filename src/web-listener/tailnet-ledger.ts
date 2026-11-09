import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { replaceFileAtomically } from "../shared-policy/replace-file-atomically.ts";
import { parseNamingTheField } from "../web-api-contract/parse-naming-the-field.ts";
import { readTextFileIfPresent } from "../where-i-stand/file-presence.ts";

const tailnetLedger = z.object({
  places: z.array(z.object({ httpsPort: z.number().int(), path: z.string() })),
});

export type TailnetLedger = z.infer<typeof tailnetLedger>;

const EMPTY_LEDGER: TailnetLedger = { places: [] };

export async function readTailnetLedger(ledgerPath: string): Promise<TailnetLedger> {
  const text = await readTextFileIfPresent(ledgerPath);
  if (text === undefined) return EMPTY_LEDGER;
  return parseNamingTheField(tailnetLedger, JSON.parse(text), `tailnet ledger ${ledgerPath}`);
}

export async function writeTailnetLedger(ledgerPath: string, ledger: TailnetLedger): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await replaceFileAtomically(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}
