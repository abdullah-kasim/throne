import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { COMMITTED_MIGRATIONS_DIRECTORY, openWhereIStandDatabase, whereIStandDatabasePath } from "./where-i-stand-database.ts";
import { WhereIStandStore } from "./where-i-stand.store.ts";

const versionTwoMigration = "ALTER TABLE `tab` ADD `note` text;";

let scratch: string;

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "where-i-stand-database-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function versionTwoMigrations(folder: string): Promise<string> {
  await cp(COMMITTED_MIGRATIONS_DIRECTORY, folder, { recursive: true });
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { idx: number; when: number }[] };
  const last = journal.entries.at(-1)!;
  const tag = "9999_version_two";
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag } as (typeof journal.entries)[number]);
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(path.join(folder, `${tag}.sql`), versionTwoMigration);
  return folder;
}

function snapshot(throneHome: string): { rows: unknown[]; applied: unknown[]; columns: unknown[] } {
  const connection = new Database(whereIStandDatabasePath(throneHome), { readonly: true });
  try {
    return {
      rows: connection.prepare("SELECT * FROM tab ORDER BY id").all(),
      applied: connection.prepare("SELECT * FROM __drizzle_migrations ORDER BY id").all(),
      columns: connection.prepare("SELECT name FROM pragma_table_info('tab')").all(),
    };
  } finally {
    connection.close();
  }
}

test("a database already holding rows keeps them when it is upgraded from schema version 1 to version 2", async () => {
  const throneHome = path.join(scratch, "upgrade");
  const store = new WhereIStandStore(throneHome);
  await store.createTab({ name: "Kept through the upgrade", listingToken: (await store.listing()).listingToken, writer: "tester" });
  await store.onModuleDestroy();
  const before = snapshot(throneHome);

  (await openWhereIStandDatabase(throneHome, await versionTwoMigrations(path.join(scratch, "version-two")))).close();

  const upgraded = snapshot(throneHome);
  assert.deepEqual(upgraded.rows, before.rows.map((row) => ({ ...(row as object), note: null })));
  assert.equal(upgraded.applied.length, before.applied.length + 1);
  assert.ok(upgraded.columns.some((column) => (column as { name: string }).name === "note"));
});

test("opening the database a second time changes nothing", async () => {
  const throneHome = path.join(scratch, "reopen");
  const store = new WhereIStandStore(throneHome);
  await store.createTab({ name: "Present before the second open", listingToken: (await store.listing()).listingToken, writer: "tester" });
  await store.onModuleDestroy();
  const first = snapshot(throneHome);

  (await openWhereIStandDatabase(throneHome)).close();

  assert.deepEqual(snapshot(throneHome), first);
});
