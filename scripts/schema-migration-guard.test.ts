import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { findSchemaChangeWithoutMigration } from "./schema-migration-guard.mjs";
import { checkHostDistIsFresh } from "./suite-host-pre-guards.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = "src/where-i-stand-store/where-i-stand.schema.ts";
const lockSchemaFile = "src/shared-policy/lock-rows/lock-rows.schema.ts";
const scratchFolders: string[] = [];

after(() => {
  for (const folder of scratchFolders) rmSync(folder, { recursive: true, force: true });
});

function copyRepoSchemaAndMigrations(): string {
  const scratchRepo = mkdtempSync(path.join(os.tmpdir(), "schema-guard-repo-"));
  scratchFolders.push(scratchRepo);
  for (const file of [schemaFile, lockSchemaFile]) {
    mkdirSync(path.join(scratchRepo, path.dirname(file)), { recursive: true });
    cpSync(path.join(repoRoot, file), path.join(scratchRepo, file));
  }
  for (const folder of ["drizzle", "drizzle-locks"]) {
    cpSync(path.join(repoRoot, folder), path.join(scratchRepo, folder), { recursive: true });
  }
  cpSync(path.join(repoRoot, "package.json"), path.join(scratchRepo, "package.json"));
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(scratchRepo, "node_modules"));
  return scratchRepo;
}

test("a schema matching its migrations passes the guard", () => {
  assert.equal(findSchemaChangeWithoutMigration(copyRepoSchemaAndMigrations()), undefined);
});

test("a schema change with no migration written fails the guard naming the cause", () => {
  const scratchRepo = copyRepoSchemaAndMigrations();
  const schemaPath = path.join(scratchRepo, schemaFile);
  const schema = readFileSync(schemaPath, "utf8");
  writeFileSync(schemaPath, schema.replace('name: text("name").notNull(),', 'name: text("name").notNull(),\n  note: text("note"),'));

  const failure = findSchemaChangeWithoutMigration(scratchRepo);

  assert.match(failure ?? "", /where-i-stand\.schema\.ts has changed and no committed migration/);
  assert.match(failure ?? "", /npx drizzle-kit generate/);
  assert.deepEqual(
    readFileSync(path.join(scratchRepo, "drizzle/meta/_journal.json"), "utf8"),
    readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"),
  );
});

test("a lock table change with no migration written fails the guard naming the lock migrations", () => {
  const scratchRepo = copyRepoSchemaAndMigrations();
  const schemaPath = path.join(scratchRepo, lockSchemaFile);
  const schema = readFileSync(schemaPath, "utf8");
  writeFileSync(schemaPath, schema.replace('takenAt: integer("taken_at").notNull(),', 'takenAt: integer("taken_at").notNull(),\n  note: text("note"),'));

  const failure = findSchemaChangeWithoutMigration(scratchRepo);

  assert.match(failure ?? "", /lock-rows\.schema\.ts has changed and no committed migration in drizzle-locks\//);
  assert.match(failure ?? "", /drizzle-locks\.config\.ts/);
});

test("npm test names the missing migration before the stale build it leaves behind", () => {
  const scratchRepo = copyRepoSchemaAndMigrations();
  const schemaPath = path.join(scratchRepo, schemaFile);
  const schema = readFileSync(schemaPath, "utf8");
  writeFileSync(schemaPath, schema.replace('name: text("name").notNull(),', 'name: text("name").notNull(),\n  note: text("note"),'));

  const result = checkHostDistIsFresh(scratchRepo);

  assert.equal(result.ok, false);
  assert.match(result.message, /no committed migration in drizzle\/ covers the change/);
  assert.doesNotMatch(result.message, /dist\//);
});
