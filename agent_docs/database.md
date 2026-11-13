# The throne database (Drizzle)

throne-backend keeps one SQLite file, `where-i-stand.sqlite3`, in each install's
throne data home. Its tables are declared in TypeScript with Drizzle
(`drizzle-orm` 0.45.4, `drizzle-kit` 0.31.11, both pinned exactly). It holds the
where-i-stand page: `tab`, `section` (with an optional parent section),
`content` and `journal`.
The regent queue and the message queue are separate stores; they stay on
hand-written SQL over Node's built-in `node:sqlite` and are not part of this
database.

## Where things live

| What | Where |
|---|---|
| Schema | `src/where-i-stand-store/where-i-stand.schema.ts` |
| drizzle-kit settings | `drizzle.config.ts` (dialect, schema file, `out: ./drizzle`) |
| Committed migrations | `drizzle/` (`NNNN_<name>.sql` plus `drizzle/meta/`) |
| Open and migrate | `openWhereIStandDatabase` in `src/where-i-stand-store/where-i-stand-database.ts` |
| Store | `WhereIStandStore` in `src/where-i-stand-store/where-i-stand.store.ts`, a provider of the web listener inside throne-backend |
| Route | `/api/where-i-stand/store/...` (`where-i-stand-store.controller.ts`); commands reach it with `connectToWhereIStand` in `where-i-stand-client.ts`, or open the file in-process with `--local` |
| Contract | Zod schemas in `src/web-api-contract/where-i-stand.ts`; rows map to it through `row-to-contract.ts` |

The migrations folder is read at runtime from the throne root, so compiled
`dist/` uses the repository's `drizzle/` with no copy step.

## The driver

Drizzle 0.45.4 has no driver for Node's built-in `node:sqlite`; that driver
exists only on the 1.0 beta line, which throne does not use. The store uses
`drizzle-orm/better-sqlite3` with `better-sqlite3` 13.1.1. Its npm package ships
prebuilt binaries for linux, linuxmusl, darwin and win32 on x64 and arm64, and
loads them directly, so installing compiles and downloads nothing and
`allowScripts` needs no entry for it.

## Changing the schema

1. Edit the schema file.
2. Write the migration: `bunx drizzle-kit generate --name <what changed>`. It
   compares the schema with `drizzle/meta/` and writes the next SQL file. When
   a table or column is dropped and another added, it asks whether that is a
   rename, and it needs a terminal to ask.
3. Commit the schema edit, the new SQL file and `drizzle/meta/` together.
4. Run `bun run typecheck`. Every piece of code that reads a changed column
   fails to compile until it is fixed, including the mapping to the Zod
   contract, so a change the page would see cannot pass unnoticed.

There is no generate step at install or build time: Drizzle's types come from
the schema file itself, and the migrations are files in the repository.

## How migrations are applied

`openWhereIStandDatabase` runs Drizzle's own migrator
(`drizzle-orm/better-sqlite3/migrator`) every time it opens the database. It
applies the committed migrations the database has not seen yet, records them in
`__drizzle_migrations`, and changes nothing when there are none. A migration that
fails closes the database and throws an error naming the migrations folder.
throne-backend opens the database the first time the store is used.

install.sh and `scripts/update-throne.mjs` need no step of their own. An install
builds and starts throne-backend, and an update rebuilds and restarts a
throne-backend whose build is stale. The new backend applies any new migrations
the first time it opens the database.

## The schema-versus-migrations guard

`scripts/schema-migration-guard.mjs` runs `drizzle-kit generate` into a temporary
copy of `drizzle/` and fails if that would write a new migration, which means the
schema changed and no committed migration covers it, or if drizzle-kit prints an
error (it does when a change could be a rename and it has no terminal to ask).
The real `drizzle/` is never written. `bun run build` runs it before compiling, and `bun run test` runs it inside
the container before the tests. Its message names the schema file and the
command to run:

```
schema-migration-guard: src/where-i-stand-store/where-i-stand.schema.ts has changed and no committed migration in drizzle/ covers the change. Write one with `bunx drizzle-kit generate` and commit it.
```

It needs drizzle-kit, a development dependency, so it runs where the build and
the tests run and never on the backend's own path.

## Raw SQL

Write queries with Drizzle's typed builder. Use the `sql` template to write a
whole query only where the builder cannot express it, and give each such query a
test that runs it. A raw query is invisible to the compiler, so a schema change
would not break it. A `sql` column default inside the schema, such as
`(unixepoch())`, is not a query and is fine.

## Running the sources directly

`bin/throne-cli` and production both run the compiled `dist/` build. Running the
TypeScript sources directly with Bun skips the emitted decorator metadata Nest
needs, so to run the store or the route, build with `bun run build` and run
`dist/`.
