import { copyFile, mkdir, open, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { readAgentTimingsRaw } from "../src/agent-timings/agent-timing-log.ts";
import { resolveRegentQueueDatabasePath } from "../src/regent-queue/regent-queue-database.ts";
import { THRONE_DATA_DIR } from "../src/shared-policy/throne-home.ts";

export const LEGACY_PROVENANCE_BASENAME = "tree-base.cancelled-unmerged.json";
export const PROVENANCE_BASENAME = "tree-base.abandoned-unmerged.json";
export const TIMINGS_RELATIVE_PATH = path.join("stats", "agent-timings.jsonl");
const LEGACY_TIMING_REASON_TOKEN = Buffer.from('"reap_reason":"cancelled"');
const TIMING_REASON_TOKEN = Buffer.from('"reap_reason":"abandoned"');
const LEGACY_QUEUE_STATUS = "cancelled";

export interface MigrationRequest {
  readonly dataRoot: string;
  readonly backupDir: string;
  readonly apply: boolean;
}

export interface ProvenanceRename {
  readonly from: string;
  readonly to: string;
}

export interface LegacyDataCounts {
  readonly provenanceFiles: number;
  readonly timingRows: number;
  readonly queueRows: number;
}

export interface MigrationReport {
  readonly applied: boolean;
  readonly backupDir: string;
  readonly before: LegacyDataCounts;
  readonly renames: readonly ProvenanceRename[];
  readonly refusedRenames: readonly ProvenanceRename[];
  readonly timingRowRewrites: number;
  readonly queueStatusCounts: Readonly<Record<string, number>>;
  readonly after: LegacyDataCounts;
}

export async function findLegacyProvenanceFiles(dataRoot: string): Promise<string[]> {
  const entries = await readdir(dataRoot, { recursive: true });
  return entries
    .filter((entry) => path.basename(entry) === LEGACY_PROVENANCE_BASENAME)
    .map((entry) => path.join(dataRoot, entry))
    .sort();
}

export function planProvenanceRenames(files: readonly string[]): {
  renames: ProvenanceRename[];
  refusedRenames: ProvenanceRename[];
} {
  const planned = files.map((from) => ({ from, to: path.join(path.dirname(from), PROVENANCE_BASENAME) }));
  return {
    renames: planned.filter((rename) => !existsSync(rename.to)),
    refusedRenames: planned.filter((rename) => existsSync(rename.to)),
  };
}

export function findLegacyTimingReasonOffsets(timings: Buffer): number[] {
  const offsets: number[] = [];
  for (
    let offset = timings.indexOf(LEGACY_TIMING_REASON_TOKEN);
    offset !== -1;
    offset = timings.indexOf(LEGACY_TIMING_REASON_TOKEN, offset + LEGACY_TIMING_REASON_TOKEN.length)
  ) {
    offsets.push(offset);
  }
  return offsets;
}

async function readLegacyTimingReasonOffsets(timingsFile: string): Promise<number[]> {
  return findLegacyTimingReasonOffsets(Buffer.from(await readAgentTimingsRaw(timingsFile), "utf8"));
}

export function countQueueStatuses(dataRoot: string): Record<string, number> {
  const db = new DatabaseSync(resolveRegentQueueDatabasePath(dataRoot), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT status, COUNT(*) AS count FROM queue_items GROUP BY status ORDER BY status")
      .all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  } finally {
    db.close();
  }
}

async function countLegacyData(dataRoot: string): Promise<LegacyDataCounts> {
  return {
    provenanceFiles: (await findLegacyProvenanceFiles(dataRoot)).length,
    timingRows: (await readLegacyTimingReasonOffsets(path.join(dataRoot, TIMINGS_RELATIVE_PATH))).length,
    queueRows: countQueueStatuses(dataRoot)[LEGACY_QUEUE_STATUS] ?? 0,
  };
}

async function backUpFiles(dataRoot: string, backupDir: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const backupFile = path.join(backupDir, path.relative(dataRoot, file));
    await mkdir(path.dirname(backupFile), { recursive: true });
    await copyFile(file, backupFile);
  }
}

async function renameProvenanceFiles(renames: readonly ProvenanceRename[]): Promise<void> {
  for (const { from, to } of renames) {
    await rename(from, to);
  }
}

async function rewriteLegacyTimingReasons(timingsFile: string, offsets: readonly number[]): Promise<void> {
  const handle = await open(timingsFile, "r+");
  try {
    for (const offset of offsets) {
      await handle.write(TIMING_REASON_TOKEN, 0, TIMING_REASON_TOKEN.length, offset);
    }
  } finally {
    await handle.close();
  }
}

export async function migrateCancelledToAbandoned(request: MigrationRequest): Promise<MigrationReport> {
  const { dataRoot, backupDir, apply } = request;
  const timingsFile = path.join(dataRoot, TIMINGS_RELATIVE_PATH);
  const legacyFiles = await findLegacyProvenanceFiles(dataRoot);
  const timingOffsets = await readLegacyTimingReasonOffsets(timingsFile);
  const queueStatusCounts = countQueueStatuses(dataRoot);
  const { renames, refusedRenames } = planProvenanceRenames(legacyFiles);
  const timingsNeedRewrite = timingOffsets.length > 0;
  if (apply) {
    const filesToChange = [...renames.map((rename) => rename.from), ...(timingsNeedRewrite ? [timingsFile] : [])];
    await backUpFiles(dataRoot, backupDir, filesToChange);
    await renameProvenanceFiles(renames);
    if (timingsNeedRewrite) await rewriteLegacyTimingReasons(timingsFile, timingOffsets);
  }
  return {
    applied: apply,
    backupDir,
    before: {
      provenanceFiles: legacyFiles.length,
      timingRows: timingOffsets.length,
      queueRows: queueStatusCounts[LEGACY_QUEUE_STATUS] ?? 0,
    },
    renames,
    refusedRenames,
    timingRowRewrites: timingOffsets.length,
    queueStatusCounts,
    after: await countLegacyData(dataRoot),
  };
}

function formatCounts(label: string, counts: LegacyDataCounts): string {
  return `${label}: ${LEGACY_PROVENANCE_BASENAME} files ${counts.provenanceFiles}, "reap_reason":"cancelled" timing rows ${counts.timingRows}, queue rows with status cancelled ${counts.queueRows}`;
}

export function formatMigrationReport(report: MigrationReport): string {
  const renameVerb = report.applied ? "renamed" : "would rename";
  const rewriteVerb = report.applied ? "rewrote" : "would rewrite";
  const nothingToDo = report.renames.length === 0 && report.refusedRenames.length === 0 && report.timingRowRewrites === 0;
  return [
    report.applied ? `Applied. Backup: ${report.backupDir}` : "Dry run: nothing was changed. Pass --apply to migrate.",
    formatCounts("Before", report.before),
    `Queue status counts: ${JSON.stringify(report.queueStatusCounts)}`,
    ...(nothingToDo ? ["Nothing to migrate."] : []),
    ...report.renames.map((rename) => `${renameVerb} ${rename.from} -> ${rename.to}`),
    ...report.refusedRenames.map((rename) => `refused ${rename.from}: ${rename.to} already exists`),
    `${rewriteVerb} ${report.timingRowRewrites} timing rows from cancelled to abandoned`,
    formatCounts("After", report.after),
  ].join("\n");
}

function defaultBackupDir(dataRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(path.dirname(dataRoot), "migration-backups", `cancelled-to-abandoned-${stamp}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-root": { type: "string", default: THRONE_DATA_DIR },
      "backup-dir": { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const dataRoot = path.resolve(values["data-root"]);
  const report = await migrateCancelledToAbandoned({
    dataRoot,
    backupDir: path.resolve(values["backup-dir"] ?? defaultBackupDir(dataRoot)),
    apply: values.apply,
  });
  process.stdout.write(`${formatMigrationReport(report)}\n`);
  if (report.refusedRenames.length > 0) process.exitCode = 1;
}

const isDirectRun = process.argv[1]?.endsWith("migrate-cancelled-to-abandoned.ts") ?? false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
