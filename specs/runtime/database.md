# Throne database
Summary: Opens the where-i-stand and lock SQLite databases through Drizzle, applies its committed migrations in process, and refuses a schema no migration covers.
Code: src/where-i-stand-store/where-i-stand-database.ts, src/where-i-stand-store/where-i-stand.schema.ts, src/where-i-stand-store/row-to-contract.ts, drizzle, drizzle.config.ts, src/shared-policy/lock-rows/lock-rows.schema.ts, drizzle-locks, drizzle-locks.config.ts, scripts/schema-migration-guard.mjs
Search words: drizzle, drizzle-locks, database, migration, schema-migration-guard, better-sqlite3

## What it does

throne keeps two Drizzle SQLite files in the throne data home: `where-i-stand.sqlite3`, owned by throne-backend, and `locks.sqlite3`, opened by any throne process that takes a lock (see the lock rows spec). Both are opened by one function, `openMigratedDatabase`, on the `better-sqlite3` driver in WAL mode with foreign keys on and a five-second wait for another writer. Many processes may open a fresh file at once: switching to WAL and applying migrations are retried up to 20 times, 25 ms apart, while another process is setting the file up. The where-i-stand tables are `tab`, `section` (with an optional parent), `content` and `journal`; the lock file has one table, `locks`. Each file has its own schema file and its own committed migrations folder, `drizzle/` and `drizzle-locks/`, and every open applies the pending migrations from its folder with Drizzle's in-process migrator; an open with nothing pending changes nothing, and rows survive an upgrade. A failed migration closes the file and throws an error naming the folder. Where-i-stand rows are mapped to the Zod contract in `src/web-api-contract/where-i-stand.ts`, so renaming a column breaks the compile of every mapping that reads it. A schema change is an edit to the schema file, `bunx drizzle-kit generate` (with `--config drizzle-locks.config.ts` for the lock table), and a commit of the SQL and its `meta/` folder. The queue and message stores stay on `node:sqlite` and are not part of these databases.

## Sub-features

- DB-MIGRATE: Opening either database applies pending committed migrations; a second open changes nothing; rows survive an upgrade.
- DB-TYPED: Rows are mapped to the Zod contract; a column rename fails the compile.
- DB-GUARD: A change to either schema file with no committed migration in its folder fails `bun run build` and `bun run test`, naming the schema file and the command.
- DB-FIRST-OPEN: Many processes opening a fresh database file at once all succeed.

## How to reach it and prove it works

```
bun test ./src/where-i-stand-store/where-i-stand-database.spec.ts ./src/where-i-stand-store/row-to-contract-compile.spec.ts ./scripts/schema-migration-guard.test.ts ./src/shared-policy/lock-rows/lock-rows.spec.ts
```

Exits 0. Adding a column to `where-i-stand.schema.ts` without generating a migration makes `bun run build` exit 1 with a `schema-migration-guard:` line naming the schema file; the same holds for `lock-rows.schema.ts` and `drizzle-locks/`.

## Gotchas

The guard needs drizzle-kit, a dev dependency, so it runs on build and test only, never on the installed backend. The migrations folders are read from the throne root at runtime, so `dist/` needs no copy. install.sh and update-throne need no step: the restarted backend migrates on its first open.
