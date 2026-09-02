import { cp, lstat, mkdir, readlink, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DATA_DIR } from "./runtime-data-home.ts";
import { RUNTIME_THRONE_ROOT } from "./runtime-throne-root.ts";

const STAGING_NAME = ".migration-staging";
const JOURNAL_NAME = ".migration-journal.json";
const COMPLETE_NAME = ".legacy-migration-complete.json";

export type MigrationResult = {
  readonly copied: number;
  readonly converged: number;
};

type MigrationOptions = {
  readonly stagingName?: string;
  readonly beforePromote?: () => Promise<void>;
};

export type RuntimeDataBootstrapOptions = {
  readonly sourceRoot?: string;
  readonly destinationRoot?: string;
};

/**
 * Converge legacy checkout state before the compiled command graph is built.
 * The default source is the installed throne root captured by the emitted
 * module, while tests may provide an explicit hermetic source.
 */
export async function bootstrapRuntimeDataHome(
  options: RuntimeDataBootstrapOptions = {},
): Promise<MigrationResult> {
  const sourceRoot = options.sourceRoot ?? path.join(RUNTIME_THRONE_ROOT, "data");
  const destinationRoot = options.destinationRoot ?? RUNTIME_DATA_DIR;
  const complete = path.join(destinationRoot, COMPLETE_NAME);
  try {
    await lstat(complete);
    return { copied: 0, converged: 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const result = await migrateRuntimeDataHome(sourceRoot, destinationRoot);
    const temporary = `${complete}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ sourceRoot, completedAt: new Date().toISOString() }), {
      mode: 0o600,
    });
    await rename(temporary, complete);
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { copied: 0, converged: 0 };
    throw error;
  }
}

function relativeEntries(root: string, current = root): Promise<string[]> {
  return readdir(current, { withFileTypes: true }).then(async (entries) => {
    const paths: string[] = [];
    for (const entry of entries) {
      const relative = path.relative(root, path.join(current, entry.name));
      if (relative === STAGING_NAME || relative === JOURNAL_NAME) continue;
      paths.push(relative);
      if (entry.isDirectory()) paths.push(...await relativeEntries(root, path.join(current, entry.name)));
    }
    return paths;
  });
}

async function sameFile(source: string, destination: string): Promise<boolean> {
  const [sourceStat, destinationStat] = await Promise.all([lstat(source), lstat(destination)]);
  if (sourceStat.isDirectory() !== destinationStat.isDirectory()) throw new Error(`migration conflict: ${destination} changes type`);
  if (sourceStat.isDirectory()) return true;
  if (sourceStat.isSymbolicLink() || destinationStat.isSymbolicLink()) {
    if (!sourceStat.isSymbolicLink() || !destinationStat.isSymbolicLink()) {
      throw new Error(`migration conflict: ${destination} changes type`);
    }
    const [sourceTarget, destinationTarget] = await Promise.all([
      readlink(source),
      readlink(destination),
    ]);
    if (sourceTarget !== destinationTarget) {
      throw new Error(`migration conflict: ${destination} symlink target differs from source`);
    }
    return true;
  }
  if (!sourceStat.isFile() || !destinationStat.isFile()) throw new Error(`migration conflict: ${destination} is not a regular file`);
  const [sourceBytes, destinationBytes] = await Promise.all([readFile(source), readFile(destination)]);
  if (!sourceBytes.equals(destinationBytes)) throw new Error(`migration conflict: ${destination} differs from source`);
  return true;
}

async function preflight(sourceRoot: string, destinationRoot: string): Promise<string[]> {
  const entries = await relativeEntries(sourceRoot);
  const missing: string[] = [];
  for (const relative of entries) {
    const source = path.join(sourceRoot, relative);
    if ((await lstat(source)).isDirectory()) continue;
    const destination = path.join(destinationRoot, relative);
    try { await sameFile(source, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(relative);
      else throw error;
    }
  }
  return missing;
}

async function copyEntry(sourceRoot: string, destinationRoot: string, relative: string): Promise<void> {
  const source = path.join(sourceRoot, relative);
  const destination = path.join(destinationRoot, relative);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
  });
}

export async function migrateRuntimeDataHome(
  sourceRoot: string,
  destinationRoot: string,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const staging = path.join(destinationRoot, options.stagingName ?? STAGING_NAME);
  const journal = path.join(destinationRoot, JOURNAL_NAME);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const missing = await preflight(sourceRoot, destinationRoot);
  if (missing.length === 0) return { copied: 0, converged: (await relativeEntries(sourceRoot)).length };
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await writeFile(journal, JSON.stringify({ sourceRoot, destinationRoot, missing }), { mode: 0o600 });
  try {
    for (const relative of missing) await copyEntry(sourceRoot, staging, relative);
    await options.beforePromote?.();
    for (const relative of missing) {
      await mkdir(path.dirname(path.join(destinationRoot, relative)), { recursive: true, mode: 0o700 });
      await rename(path.join(staging, relative), path.join(destinationRoot, relative));
    }
    await rm(staging, { recursive: true, force: true });
    await rm(journal, { force: true });
    return { copied: missing.length, converged: (await relativeEntries(sourceRoot)).length - missing.length };
  } catch (error) {
    throw new Error(`runtime data migration interrupted; rerun is safe: ${error instanceof Error ? error.message : String(error)}`);
  }
}
