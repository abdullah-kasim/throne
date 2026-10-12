import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { realAppendAgentTiming } from "../src/agent-timings/agent-timing-log.ts";
import { buildAgentTimingRow } from "../src/agent-timings/agent-timing.types.ts";
import { REAP_REASON } from "../src/agent-timings/reap-reason.ts";
import { resolveRegentQueueDatabasePath } from "../src/regent-queue/regent-queue-database.ts";
import { openRegentQueueStore, RegentQueueItemStatus } from "../src/regent-queue/regent-queue.store.ts";
import {
  formatMigrationReport,
  LEGACY_PROVENANCE_BASENAME,
  migrateCancelledToAbandoned,
  PROVENANCE_BASENAME,
  TIMINGS_RELATIVE_PATH,
} from "./migrate-cancelled-to-abandoned.ts";

const LEDGERS_WITH_LEGACY_PROVENANCE = ["alpha-live-01", path.join(".reaped", "alpha-old-01"), path.join(".reaped", "shadow-old-02")];
const LEGACY_PROVENANCE_FILES = LEDGERS_WITH_LEGACY_PROVENANCE.map((ledger) => path.join(ledger, LEGACY_PROVENANCE_BASENAME));
const MIXED_REAP_REASONS = ["completed", "cancelled", "force", "cancelled", "superseded"];
const SQLITE_READER_SIDE_FILE_SUFFIXES = ["-wal", "-shm"];

interface DataRootFixture {
  readonly dataRoot: string;
  readonly backupDir: string;
}

function timingLine(name: string, reapReason: string): string {
  return `${JSON.stringify({
    name,
    role: "Alpha",
    harness: "claude",
    model: "opus",
    spawned_at: "2026-09-01T00:00:00.000Z",
    reaped_at: "2026-09-01T01:00:00.000Z",
    reap_reason: reapReason,
    duration_ms: 3600000,
  })}\n`;
}

function writeFixtureFile(dataRoot: string, relativePath: string, content: string): void {
  mkdirSync(path.dirname(path.join(dataRoot, relativePath)), { recursive: true });
  writeFileSync(path.join(dataRoot, relativePath), content);
}

function buildDataRoot(dataRoot: string, timingReasons: readonly string[] = MIXED_REAP_REASONS): void {
  for (const ledger of LEDGERS_WITH_LEGACY_PROVENANCE) {
    writeFixtureFile(dataRoot, path.join(ledger, LEGACY_PROVENANCE_BASENAME), `{"name":"${path.basename(ledger)}"}\n`);
  }
  writeFixtureFile(dataRoot, path.join("alpha-other-01", "tree-base.json"), '{"name":"alpha-other-01"}\n');
  writeFixtureFile(dataRoot, TIMINGS_RELATIVE_PATH, timingReasons.map((reason, index) => timingLine(`agent-${index}`, reason)).join(""));
  const store = openRegentQueueStore(resolveRegentQueueDatabasePath(dataRoot));
  const finished = store.insertItem({ objectiveCode: "finished", body: "INTENT: landed" });
  store.mutateItem(finished.id, { status: RegentQueueItemStatus.Complete });
  store.insertItem({ objectiveCode: "waiting", body: "INTENT: still open" });
  store.close();
}

async function withDataRoot(run: (fixture: DataRootFixture) => Promise<void>, timingReasons?: readonly string[]): Promise<void> {
  const parent = mkdtempSync(path.join(tmpdir(), "migrate-cancelled-"));
  const fixture = { dataRoot: path.join(parent, "data"), backupDir: path.join(parent, "backup") };
  try {
    buildDataRoot(fixture.dataRoot, timingReasons);
    await run(fixture);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function snapshotFiles(dataRoot: string): Map<string, string> {
  const files = readdirSync(dataRoot, { recursive: true, withFileTypes: true }).filter(
    (entry) => entry.isFile() && !SQLITE_READER_SIDE_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)),
  );
  return new Map(
    files.map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(dataRoot, file), readFileSync(file, "latin1")];
    }),
  );
}

function readRelative(dataRoot: string, relativePath: string): string {
  return readFileSync(path.join(dataRoot, relativePath), "utf8");
}

test("the migration dry run lists every change and changes nothing", async () => {
  await withDataRoot(async ({ dataRoot, backupDir }) => {
    const before = snapshotFiles(dataRoot);

    const report = await migrateCancelledToAbandoned({ dataRoot, backupDir, apply: false });

    assert.deepEqual(
      report.renames.map((rename) => path.relative(dataRoot, rename.from)),
      [...LEGACY_PROVENANCE_FILES].sort(),
    );
    assert.equal(report.timingRowRewrites, 2);
    assert.deepEqual(report.before, { provenanceFiles: 3, timingRows: 2, queueRows: 0 });
    assert.deepEqual(snapshotFiles(dataRoot), before);
    assert.equal(existsSync(backupDir), false);
    const printed = formatMigrationReport(report);
    assert.match(printed, /^Dry run: nothing was changed/);
    for (const rename of report.renames) assert.ok(printed.includes(`would rename ${rename.from} -> ${rename.to}`));
    assert.ok(printed.includes("would rewrite 2 timing rows"));
  });
});

test("the migration backs up every file before it changes it", async () => {
  await withDataRoot(async ({ dataRoot, backupDir }) => {
    const before = snapshotFiles(dataRoot);

    await migrateCancelledToAbandoned({ dataRoot, backupDir, apply: true });

    for (const relativePath of [...LEGACY_PROVENANCE_FILES, TIMINGS_RELATIVE_PATH]) {
      assert.equal(readFileSync(path.join(backupDir, relativePath), "latin1"), before.get(relativePath));
    }
    assert.deepEqual(
      [...snapshotFiles(backupDir).keys()].sort(),
      [...LEGACY_PROVENANCE_FILES, TIMINGS_RELATIVE_PATH].sort(),
    );
  });
});

test("the migration renames every cancelled-unmerged provenance file, reaped ledgers included", async () => {
  await withDataRoot(async ({ dataRoot, backupDir }) => {
    const report = await migrateCancelledToAbandoned({ dataRoot, backupDir, apply: true });

    for (const ledger of LEDGERS_WITH_LEGACY_PROVENANCE) {
      assert.equal(existsSync(path.join(dataRoot, ledger, LEGACY_PROVENANCE_BASENAME)), false);
      assert.equal(readRelative(dataRoot, path.join(ledger, PROVENANCE_BASENAME)), `{"name":"${path.basename(ledger)}"}\n`);
    }
    assert.equal(report.after.provenanceFiles, 0);
    assert.match(formatMigrationReport(report), /After: tree-base\.cancelled-unmerged\.json files 0, "reap_reason":"cancelled" timing rows 0/);
  });
});

test("the migration rewrites only cancelled timing rows and keeps every other row byte for byte", async () => {
  await withDataRoot(async ({ dataRoot, backupDir }) => {
    const rowsBefore = readRelative(dataRoot, TIMINGS_RELATIVE_PATH).split("\n");

    const report = await migrateCancelledToAbandoned({ dataRoot, backupDir, apply: true });

    const rowsAfter = readRelative(dataRoot, TIMINGS_RELATIVE_PATH).split("\n");
    assert.deepEqual(
      rowsAfter,
      rowsBefore.map((row) => row.replace('"reap_reason":"cancelled"', '"reap_reason":"abandoned"')),
    );
    assert.deepEqual(
      rowsAfter.filter((row) => row.length > 0).map((row) => JSON.parse(row).reap_reason),
      ["completed", "abandoned", "force", "abandoned", "superseded"],
    );
    assert.equal(report.after.timingRows, 0);
  });
});

test("the migration refuses to overwrite an existing abandoned-unmerged file", async () => {
  await withDataRoot(async ({ dataRoot, backupDir }) => {
    const ambiguousLedger = LEDGERS_WITH_LEGACY_PROVENANCE[0];
    writeFixtureFile(dataRoot, path.join(ambiguousLedger, PROVENANCE_BASENAME), '{"name":"already-abandoned"}\n');

    const report = await migrateCancelledToAbandoned({ dataRoot, backupDir, apply: true });

    assert.equal(readRelative(dataRoot, path.join(ambiguousLedger, PROVENANCE_BASENAME)), '{"name":"already-abandoned"}\n');
    assert.equal(readRelative(dataRoot, path.join(ambiguousLedger, LEGACY_PROVENANCE_BASENAME)), `{"name":"${path.basename(ambiguousLedger)}"}\n`);
    assert.deepEqual(
      report.refusedRenames.map((rename) => path.relative(dataRoot, rename.from)),
      [path.join(ambiguousLedger, LEGACY_PROVENANCE_BASENAME)],
    );
    assert.equal(report.renames.length, 2);
    assert.equal(report.after.provenanceFiles, 1);
    assert.ok(formatMigrationReport(report).includes(`refused ${path.join(dataRoot, ambiguousLedger, LEGACY_PROVENANCE_BASENAME)}`));
  });
});

test("a timing row appended while the migration runs is not lost", async () => {
  const manyMixedReasons = Array.from({ length: 20000 }, (_, index) => (index % 2 === 0 ? "cancelled" : "completed"));
  await withDataRoot(async ({ dataRoot, backupDir }) => {
    const appendTiming = realAppendAgentTiming(path.join(dataRoot, TIMINGS_RELATIVE_PATH));
    let migrationFinished = false;
    const migration = migrateCancelledToAbandoned({ dataRoot, backupDir, apply: true }).finally(() => {
      migrationFinished = true;
    });
    const appendedNames: string[] = [];
    while (!migrationFinished) {
      const name = `appended-${appendedNames.length}`;
      await appendTiming(
        buildAgentTimingRow({
          name,
          role: "Shadow",
          harness: "claude",
          model: "opus",
          spawnedAt: null,
          reapedAt: new Date().toISOString(),
          reapReason: REAP_REASON.COMPLETED,
        }),
      );
      appendedNames.push(name);
    }
    const report = await migration;

    const namesInFile = new Set(
      readRelative(dataRoot, TIMINGS_RELATIVE_PATH)
        .split("\n")
        .filter((row) => row.length > 0)
        .map((row) => JSON.parse(row).name),
    );
    assert.ok(appendedNames.length > 0);
    assert.deepEqual(appendedNames.filter((name) => !namesInFile.has(name)), []);
    assert.equal(report.timingRowRewrites, 10000);
    assert.equal(report.after.timingRows, 0);
  }, manyMixedReasons);
});

test("the migration reports the queue status counts and how many rows are cancelled", async () => {
  await withDataRoot(async ({ dataRoot, backupDir }) => {
    const queueFile = resolveRegentQueueDatabasePath(dataRoot);
    const store = openRegentQueueStore(queueFile);
    const stopped = store.insertItem({ objectiveCode: "stopped", body: "INTENT: stopped under the old name" });
    store.close();
    const legacyWriter = new DatabaseSync(queueFile);
    legacyWriter.prepare("UPDATE queue_items SET status = 'cancelled' WHERE id = ?").run(stopped.id);
    legacyWriter.close();

    const report = await migrateCancelledToAbandoned({ dataRoot, backupDir, apply: false });

    assert.deepEqual(report.queueStatusCounts, { cancelled: 1, complete: 1, open: 1 });
    assert.equal(report.before.queueRows, 1);
    const printed = formatMigrationReport(report);
    assert.ok(printed.includes('Queue status counts: {"cancelled":1,"complete":1,"open":1}'));
    assert.ok(printed.includes("queue rows with status cancelled 1"));
  });
});

test("running the migration twice changes nothing the second time", async () => {
  await withDataRoot(async ({ dataRoot, backupDir }) => {
    await migrateCancelledToAbandoned({ dataRoot, backupDir, apply: true });
    const afterFirstRun = snapshotFiles(dataRoot);
    const secondBackupDir = `${backupDir}-second`;

    const secondReport = await migrateCancelledToAbandoned({ dataRoot, backupDir: secondBackupDir, apply: true });

    assert.deepEqual(snapshotFiles(dataRoot), afterFirstRun);
    assert.deepEqual(secondReport.renames, []);
    assert.equal(secondReport.timingRowRewrites, 0);
    assert.deepEqual(secondReport.before, { provenanceFiles: 0, timingRows: 0, queueRows: 0 });
    assert.equal(existsSync(secondBackupDir), false);
    assert.ok(formatMigrationReport(secondReport).includes("Nothing to migrate."));
  });
});
