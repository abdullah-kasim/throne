import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ARCHIVE_PATH = path.join(
  process.env.HOME ?? homedir(),
  ".throne",
  "data",
  "stats",
  "redis-delivery-archive.jsonl",
);
const REDIS_CONTAINER = "throne-redis";
const COMPLETED_KEY = "bull:throne-message-delivery:completed";
const FAILED_KEY = "bull:throne-message-delivery:failed";
const EXPECTED_RECORD_COUNT = 15_067;
const EXPECTED_COMPLETED_NEWEST_SCORE = 1_787_798_832_497;
const EXPECTED_FAILED_NEWEST_SCORE = 1_787_280_260_388;

type DeliveryState = "completed" | "failed";

interface ArchiveRecord {
  readonly jobId: string;
  readonly state: DeliveryState;
  readonly score: number;
  readonly payload: Record<string, unknown>;
}

interface LegacyArchiveRecord {
  readonly id: string;
  readonly state: DeliveryState;
  readonly score: number;
  readonly payload: Record<string, unknown>;
}

interface RedisSnapshot {
  readonly dbsize: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly completedNewestScore: number;
  readonly failedNewestScore: number;
}

interface ArchiveSummary {
  readonly recordCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly numericLegacyIdCount: number;
  readonly completedNewestScore: number;
  readonly failedNewestScore: number;
}

function archivePathFromArgs(args: readonly string[]): string {
  if (args.length === 0) return ARCHIVE_PATH;
  if (args.length === 1) return path.resolve(args[0]);
  throw new Error("usage: export-redis-delivery-archive.ts [archive-path]");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const recordKeys = Object.keys(record);
  return (
    recordKeys.length === keys.length && keys.every((key) => key in record)
  );
}

function validateRecord(
  value: unknown,
  lineNumber: number,
): ArchiveRecord | LegacyArchiveRecord {
  if (!isObject(value))
    throw new Error(`line ${lineNumber}: record must be an object`);

  const hasJobId = "jobId" in value;
  const hasId = "id" in value;
  if (hasJobId === hasId) {
    throw new Error(
      `line ${lineNumber}: record must contain exactly one of jobId or id`,
    );
  }

  const identifierKey = hasJobId ? "jobId" : "id";
  if (!hasExactKeys(value, [identifierKey, "state", "score", "payload"])) {
    throw new Error(`line ${lineNumber}: record has unexpected fields`);
  }
  if (
    typeof value[identifierKey] !== "string" ||
    value[identifierKey].length === 0
  ) {
    throw new Error(
      `line ${lineNumber}: ${identifierKey} must be a non-empty string`,
    );
  }
  if (value.state !== "completed" && value.state !== "failed") {
    throw new Error(`line ${lineNumber}: state must be completed or failed`);
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw new Error(`line ${lineNumber}: score must be a finite number`);
  }
  if (!isObject(value.payload)) {
    throw new Error(`line ${lineNumber}: payload must be an object`);
  }

  return value as ArchiveRecord | LegacyArchiveRecord;
}

function isLegacyRecord(
  record: ArchiveRecord | LegacyArchiveRecord,
): record is LegacyArchiveRecord {
  return "id" in record;
}

function normalizeRecord(record: LegacyArchiveRecord): ArchiveRecord {
  return {
    jobId: record.id,
    state: record.state,
    score: record.score,
    payload: record.payload,
  };
}

async function queryRedis(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("podman", [
    "exec",
    REDIS_CONTAINER,
    "redis-cli",
    "--raw",
    ...args,
  ]);
  return stdout.trim();
}

async function readRedisInteger(...args: string[]): Promise<number> {
  const value = Number(await queryRedis(...args));
  if (!Number.isSafeInteger(value))
    throw new Error(`Redis returned a non-integer for ${args.join(" ")}`);
  return value;
}

async function readNewestScore(key: string): Promise<number> {
  const output = await queryRedis("ZREVRANGE", key, "0", "0", "WITHSCORES");
  const lines = output.split("\n");
  if (lines.length !== 2 || lines[0].length === 0)
    throw new Error(`Redis set ${key} has no newest score`);
  const score = Number(lines[1]);
  if (!Number.isFinite(score))
    throw new Error(`Redis returned an invalid newest score for ${key}`);
  return score;
}

async function readRedisSnapshot(): Promise<RedisSnapshot> {
  const [
    dbsize,
    completedCount,
    failedCount,
    completedNewestScore,
    failedNewestScore,
  ] = await Promise.all([
    readRedisInteger("DBSIZE"),
    readRedisInteger("ZCARD", COMPLETED_KEY),
    readRedisInteger("ZCARD", FAILED_KEY),
    readNewestScore(COMPLETED_KEY),
    readNewestScore(FAILED_KEY),
  ]);
  return {
    dbsize,
    completedCount,
    failedCount,
    completedNewestScore,
    failedNewestScore,
  };
}

function assertRedisSnapshot(snapshot: RedisSnapshot): void {
  if (
    snapshot.completedCount + snapshot.failedCount !==
    EXPECTED_RECORD_COUNT
  ) {
    throw new Error(
      `Redis terminal count is ${snapshot.completedCount + snapshot.failedCount}, expected ${EXPECTED_RECORD_COUNT}`,
    );
  }
  if (snapshot.completedNewestScore !== EXPECTED_COMPLETED_NEWEST_SCORE) {
    throw new Error(
      `Redis completed newest score is ${snapshot.completedNewestScore}, expected ${EXPECTED_COMPLETED_NEWEST_SCORE}`,
    );
  }
  if (snapshot.failedNewestScore !== EXPECTED_FAILED_NEWEST_SCORE) {
    throw new Error(
      `Redis failed newest score is ${snapshot.failedNewestScore}, expected ${EXPECTED_FAILED_NEWEST_SCORE}`,
    );
  }
}

async function reconcileArchive(
  archivePath: string,
): Promise<{ summary: ArchiveSummary; changed: boolean }> {
  const directory = path.dirname(archivePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(archivePath)}.${process.pid}.tmp`,
  );
  const input = createReadStream(archivePath, { encoding: "utf8" });
  const output = createWriteStream(temporaryPath, {
    encoding: "utf8",
    flags: "wx",
    mode: 0o600,
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let recordCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let numericLegacyIdCount = 0;
  let completedNewestScore = Number.NEGATIVE_INFINITY;
  let failedNewestScore = Number.NEGATIVE_INFINITY;
  let changed = false;

  try {
    for await (const line of lines) {
      recordCount += 1;
      const record = validateRecord(JSON.parse(line), recordCount);
      if (record.state === "completed") {
        completedCount += 1;
        completedNewestScore = Math.max(completedNewestScore, record.score);
      } else {
        failedCount += 1;
        failedNewestScore = Math.max(failedNewestScore, record.score);
      }
      if (/^\d+$/.test(isLegacyRecord(record) ? record.id : record.jobId))
        numericLegacyIdCount += 1;

      const normalized = isLegacyRecord(record)
        ? normalizeRecord(record)
        : record;
      changed ||= isLegacyRecord(record);
      if (!output.write(`${JSON.stringify(normalized)}\n`))
        await once(output, "drain");
    }
    output.end();
    await once(output, "close");

    if (recordCount !== EXPECTED_RECORD_COUNT) {
      throw new Error(
        `archive has ${recordCount} records, expected ${EXPECTED_RECORD_COUNT}`,
      );
    }
    const summary = {
      recordCount,
      completedCount,
      failedCount,
      numericLegacyIdCount,
      completedNewestScore,
      failedNewestScore,
    };
    if (!changed) {
      await fs.unlink(temporaryPath);
      return { summary, changed: false };
    }

    await validateReconciledArchive(temporaryPath);
    await fs.rename(temporaryPath, archivePath);
    return { summary, changed: true };
  } catch (error) {
    output.destroy();
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function validateReconciledArchive(archivePath: string): Promise<void> {
  const input = createReadStream(archivePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let recordCount = 0;
  for await (const line of lines) {
    recordCount += 1;
    const record = validateRecord(JSON.parse(line), recordCount);
    if (isLegacyRecord(record))
      throw new Error(
        `line ${recordCount}: reconciled archive still contains id`,
      );
  }
  if (recordCount !== EXPECTED_RECORD_COUNT) {
    throw new Error(
      `reconciled archive has ${recordCount} records, expected ${EXPECTED_RECORD_COUNT}`,
    );
  }
}

function assertUnchangedRedis(
  before: RedisSnapshot,
  after: RedisSnapshot,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `Redis changed during reconciliation: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  }
}

function assertArchiveMatchesRedis(
  summary: ArchiveSummary,
  snapshot: RedisSnapshot,
): void {
  if (
    summary.completedCount !== snapshot.completedCount ||
    summary.failedCount !== snapshot.failedCount
  ) {
    throw new Error(
      `archive state counts do not match Redis: archive=${summary.completedCount}/${summary.failedCount} Redis=${snapshot.completedCount}/${snapshot.failedCount}`,
    );
  }
  if (
    summary.completedNewestScore !== snapshot.completedNewestScore ||
    summary.failedNewestScore !== snapshot.failedNewestScore
  ) {
    throw new Error(
      `archive newest scores do not match Redis: archive=${summary.completedNewestScore}/${summary.failedNewestScore} Redis=${snapshot.completedNewestScore}/${snapshot.failedNewestScore}`,
    );
  }
}

export async function reconcileRedisDeliveryArchive(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const archivePath = archivePathFromArgs(args);
  const before = await readRedisSnapshot();
  assertRedisSnapshot(before);
  const { summary, changed } = await reconcileArchive(archivePath);
  assertArchiveMatchesRedis(summary, before);
  const after = await readRedisSnapshot();
  assertRedisSnapshot(after);
  assertUnchangedRedis(before, after);
  console.log(
    JSON.stringify({ archivePath, changed, before, after, ...summary }),
  );
}

if (import.meta.main) {
  reconcileRedisDeliveryArchive().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
