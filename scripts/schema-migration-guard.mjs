import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARDED_SCHEMAS = [
  {
    schemaFile: "src/where-i-stand-store/where-i-stand.schema.ts",
    migrationsFolder: "drizzle",
    writeMigrationCommand: "npx drizzle-kit generate",
  },
  {
    schemaFile: "src/shared-policy/lock-rows/lock-rows.schema.ts",
    migrationsFolder: "drizzle-locks",
    writeMigrationCommand: "npx drizzle-kit generate --config drizzle-locks.config.ts",
  },
];

function listMigrationFiles(folder) {
  return readdirSync(folder).filter((name) => name.endsWith(".sql"));
}

export function findSchemaChangeWithoutMigration(repoRoot) {
  for (const guarded of GUARDED_SCHEMAS) {
    const failure = findOneSchemaChangeWithoutMigration(repoRoot, guarded);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function findOneSchemaChangeWithoutMigration(repoRoot, { schemaFile, migrationsFolder, writeMigrationCommand }) {
  const scratchFolder = mkdtempSync(path.join(os.tmpdir(), "schema-migration-guard-"));
  const scratchMigrations = path.join(scratchFolder, migrationsFolder);
  try {
    cpSync(path.join(repoRoot, migrationsFolder), scratchMigrations, { recursive: true });
    const committedCount = listMigrationFiles(scratchMigrations).length;
    const result = spawnSync(
      path.join(repoRoot, "node_modules", ".bin", "drizzle-kit"),
      [
        "generate",
        "--dialect",
        "sqlite",
        "--schema",
        `./${schemaFile}`,
        "--out",
        path.relative(repoRoot, scratchMigrations),
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    if (result.status !== 0 || /^Error:/m.test(`${result.stdout}${result.stderr}`)) {
      return `schema-migration-guard: drizzle-kit generate failed (exit ${result.status}): ${result.error?.message ?? `${result.stdout}${result.stderr}`.trim()}`;
    }
    if (listMigrationFiles(scratchMigrations).length === committedCount) return undefined;
    return (
      `schema-migration-guard: ${schemaFile} has changed and no committed migration in ${migrationsFolder}/ covers the change. ` +
      `Write one with \`${writeMigrationCommand}\` and commit it.`
    );
  } finally {
    rmSync(scratchFolder, { recursive: true, force: true });
  }
}

export function failIfSchemaChangedWithoutMigration(repoRoot) {
  const failure = findSchemaChangeWithoutMigration(repoRoot);
  if (failure === undefined) return;
  console.error(failure);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  failIfSchemaChangedWithoutMigration(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
