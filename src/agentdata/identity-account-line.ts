import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "./spawn-data-contracts.ts";

export const ACCOUNT_LINE_PREFIX = "- **Account:** ";

const IDENTITY_FILE_NAME = "identity.md";
const RECORD_LINE_PREFIX = "- **";

export function accountLine(account: string): string {
  return `${ACCOUNT_LINE_PREFIX}${account}`;
}

function endOfFirstRecordBlock(lines: readonly string[]): number {
  const start = lines.findIndex((line) => line.startsWith(RECORD_LINE_PREFIX));
  if (start === -1) return lines.length;
  const end = lines.findIndex((line, index) => index > start && !line.startsWith(RECORD_LINE_PREFIX));
  return end === -1 ? lines.length : end;
}

function withAccountLine(identity: string, account: string): string {
  const lines = identity.split("\n");
  const existing = lines.findIndex((line) => line.startsWith(ACCOUNT_LINE_PREFIX));
  if (existing === -1) {
    lines.splice(endOfFirstRecordBlock(lines), 0, accountLine(account));
  } else {
    lines[existing] = accountLine(account);
  }
  return lines.join("\n");
}

export async function recordAccountInIdentity(
  name: string,
  account: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<void> {
  const identityPath = path.join(baseDir, name, IDENTITY_FILE_NAME);
  let identity: string;
  try {
    identity = await readFile(identityPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await writeFile(identityPath, withAccountLine(identity, account), "utf8");
}
