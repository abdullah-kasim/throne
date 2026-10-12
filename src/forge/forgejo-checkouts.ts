import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { forgejoStateDirectory } from "../install-services/forgejo-installation.ts";
import type { ForgejoRepository } from "./forgejo-repository.ts";

const CHECKOUTS_FILE_NAME = "checkouts.json";

export type RecordedCheckouts = Readonly<Record<string, string>>;

function checkoutsFilePath(): string {
  return path.join(forgejoStateDirectory(), CHECKOUTS_FILE_NAME);
}

export function forgejoCopyName(repository: ForgejoRepository): string {
  return `${repository.owner}/${repository.name}`;
}

export async function readRecordedCheckouts(): Promise<RecordedCheckouts> {
  try {
    return JSON.parse(await readFile(checkoutsFilePath(), "utf8")) as RecordedCheckouts;
  } catch {
    return {};
  }
}

export async function recordForgejoCheckout(repository: ForgejoRepository, repo: string): Promise<void> {
  const checkout = path.resolve(repo);
  const recorded = await readRecordedCheckouts();
  if (recorded[forgejoCopyName(repository)] === checkout) return;
  const filePath = checkoutsFilePath();
  const unfinishedFilePath = `${filePath}.${process.pid}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(unfinishedFilePath, `${JSON.stringify({ ...recorded, [forgejoCopyName(repository)]: checkout }, null, 2)}\n`);
  await rename(unfinishedFilePath, filePath);
}
