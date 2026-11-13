import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { RowFields, StoredRow } from "../web-api-contract/where-i-stand.ts";
import { whereIStandDatabasePath } from "./where-i-stand-database.ts";
import { WhereIStandStore } from "./where-i-stand.store.ts";

export const WRITER = "tester";
export const DAY_MS = 24 * 60 * 60 * 1000;

export class SettableClock {
  constructor(public time = new Date("2026-06-15T12:00:00.000Z")) {}
  readonly now = (): Date => new Date(this.time);
  advance(milliseconds: number): void {
    this.time = new Date(this.time.getTime() + milliseconds);
  }
  set(time: Date): void {
    this.time = new Date(time);
  }
}

export interface ScratchStore {
  readonly home: string;
  readonly clock: SettableClock;
  readonly store: WhereIStandStore;
  close(): Promise<void>;
}

export async function scratchStore(): Promise<ScratchStore> {
  const home = await mkdtemp(path.join(os.tmpdir(), "where-i-stand-store-"));
  const clock = new SettableClock();
  const store = new WhereIStandStore(home, clock.now);
  return {
    home,
    clock,
    store,
    close: async () => {
      await store.onModuleDestroy();
      await rm(home, { recursive: true, force: true });
    },
  };
}

export async function token(store: WhereIStandStore): Promise<string> {
  return (await store.listing()).listingToken;
}

export async function createTab(store: WhereIStandStore, name: string): Promise<string> {
  const answer = await store.createTab({ name, listingToken: await token(store), writer: WRITER });
  return answer.tab!.id;
}

export async function createSection(store: WhereIStandStore, tabId: string, name: string, parentId?: string): Promise<string> {
  const answer = await store.createSection({ tabId, parentId, name, listingToken: await token(store), writer: WRITER });
  return answer.section!.id;
}

export function workEntry(code: string, whereItStands = "building"): RowFields {
  return { kind: "work", code, links: "no pull request", workKind: "bug fix — invented work", whereItStands };
}

export async function addRow(store: WhereIStandStore, sectionId: string, row: RowFields): Promise<StoredRow> {
  const answer = await store.addRow({ sectionId, listingToken: await token(store), writer: WRITER, row });
  if (answer.row === undefined) throw new Error(answer.message);
  return answer.row;
}

export function readTable(home: string, table: "content" | "journal" | "section"): Record<string, unknown>[] {
  const connection = new Database(whereIStandDatabasePath(home), { readonly: true });
  try {
    return connection.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
  } finally {
    connection.close();
  }
}

export async function addEventLines(scratch: ScratchStore, sectionId: string, count: number): Promise<void> {
  for (let line = 1; line <= count; line++) {
    await addRow(scratch.store, sectionId, { kind: "event", text: `event ${line}` });
    scratch.clock.advance(1000);
  }
}
