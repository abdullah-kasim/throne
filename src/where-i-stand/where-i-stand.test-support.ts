import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { FRAME_HEADINGS } from "./page-frame.ts";
import { pagePathIn, showPage } from "./page-store.ts";
import { runWhereIStand, type WhereIStandDependencies } from "./where-i-stand-runtime.ts";

export const WRITER = "alpha-bakery-01";
export const WRITTEN_AT = new Date("2026-10-14T09:30:00.000Z");
const LOCK_FILE_NAMES = ["where-i-stand.lock", "where-i-stand.edit.lock"];

export interface PageRoom {
  readonly dataHome: string;
  readonly dependencies: WhereIStandDependencies;
  readonly printed: string[];
  readonly complaints: string[];
  readonly regentNotices: string[];
}

export async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "where-i-stand-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function pageRoom(t: TestContext, overrides: Partial<WhereIStandDependencies> = {}): Promise<PageRoom> {
  const dataHome = path.join(await temporaryDirectory(t), "data-home");
  const printed: string[] = [];
  const complaints: string[] = [];
  const regentNotices: string[] = [];
  return {
    dataHome,
    printed,
    complaints,
    regentNotices,
    dependencies: {
      dataHome,
      currentAgentName: async () => WRITER,
      now: () => WRITTEN_AT,
      out: (message) => void printed.push(message),
      err: (message) => void complaints.push(message),
      waitForRelease: async () => undefined,
      tellRegent: async (message) => void regentNotices.push(message),
      ...overrides,
    },
  };
}

export function pageWith(sections: Partial<Record<string, string>>): string {
  return FRAME_HEADINGS.map((heading) => `${heading}\n${sections[heading] ?? ""}`).join("\n");
}

export function entry(identity: string, body: string): string {
  return `\n### ${identity}\n\n${body}\n`;
}

export async function readPageOrEmptyFrame(room: PageRoom): Promise<string> {
  return (await showPage(room.dataHome)).content;
}

export async function editThePageDirectly(room: PageRoom, change: (content: string) => string): Promise<void> {
  await writeFile(pagePathIn(room.dataHome), change(await readPageOrEmptyFrame(room)), "utf8");
}

export function dependenciesThatEditWhileHeld(
  room: PageRoom,
  change: (content: string) => string,
  extra: Partial<WhereIStandDependencies> = {},
): WhereIStandDependencies {
  return {
    ...room.dependencies,
    waitForRelease: () => editThePageDirectly(room, change),
    ...extra,
  };
}

export async function lockEditAndRelease(
  room: PageRoom,
  change: (content: string) => string,
  extra: Partial<WhereIStandDependencies> = {},
): Promise<number> {
  const checksum = (await showPage(room.dataHome)).version;
  return runWhereIStand(["lock", "--checksum", checksum], dependenciesThatEditWhileHeld(room, change, extra));
}

export async function filesBesideThePage(room: PageRoom): Promise<Record<string, string>> {
  const names = (await readdir(room.dataHome)).filter((name) => !LOCK_FILE_NAMES.includes(name)).sort();
  const files: Record<string, string> = {};
  for (const name of names) files[name] = await readFile(path.join(room.dataHome, name), "utf8");
  return files;
}
