import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AlphaFloorBreachTracker } from "./alpha-floor-breach-tracker.ts";
import { AUTOSCALE_KILL_SWITCH_ENV_VAR } from "./kill-switch.ts";
import { renderAutoscaleStatusFrom } from "./autoscale-status-route.ts";
import {
  buildAutoscaleStatusCourt,
  statusSourcesOver,
  takeMoreWorkAt,
  type CourtReading,
} from "./autoscale-status-test-fixtures.ts";

const court = buildAutoscaleStatusCourt();

function fingerprint(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function fingerprintCourtFiles(): Record<string, string> {
  const queueFiles = Object.fromEntries(
    readdirSync(court.queueDirectory)
      .sort()
      .map((name) => [name, fingerprint(path.join(court.queueDirectory, name))]),
  );
  return {
    ...queueFiles,
    spawnState: fingerprint(court.spawnStatePath),
    launchLedger: fingerprint(court.ledgerPath),
  };
}

async function statusText(reading: CourtReading = {}): Promise<string> {
  return renderAutoscaleStatusFrom(statusSourcesOver(court, reading), []);
}

async function statusJson(reading: CourtReading = {}): Promise<Record<string, any>> {
  return JSON.parse(await renderAutoscaleStatusFrom(statusSourcesOver(court, reading), ["--json"]));
}

async function prediction(reading: CourtReading): Promise<string> {
  return (await statusJson(reading)).prediction;
}

const SEVEN_LIVE_ALPHAS = Array.from({ length: 7 }, (_, index) => `alpha-live-${index}-01`);

test("checking the autoscaler's status changes nothing on disk and does not advance the breach timer", async () => {
  let clockMs = 1_000_000;
  const breachTracker = new AlphaFloorBreachTracker(() => clockMs);
  const before = fingerprintCourtFiles();

  const report = await statusJson({ breachTracker });
  clockMs += 60_000;

  assert.deepEqual(report.queue.wouldBrief, ["beta", "alpha"]);
  assert.deepEqual(
    report.queue.deferred.map((row: { objectiveCode: string; wouldRelease: boolean }) => [row.objectiveCode, row.wouldRelease]),
    [["gamma", true], ["held", false]],
  );
  assert.equal(report.slots.floorBreached, true);
  assert.deepEqual(fingerprintCourtFiles(), before);
  assert.equal(breachTracker.currentBreachDurationMs(), 0);
});

test("a paused autoscaler in config reports it would skip with the config reason", async () => {
  const reason = "autoscaler disabled in config.user.ts (steering.autoscaleEnabled: false)";
  const report = await statusJson({ configPause: { enabled: false, reason } });
  assert.equal(report.prediction, `would skip: ${reason}`);
  assert.equal(report.autoscaler.running, false);
  assert.equal(report.autoscaler.configPauseReason, reason);
});

test("a kill switch set to 0 reports it would skip because the kill switch is off", async () => {
  const text = await statusText({ killSwitchEnvironment: { [AUTOSCALE_KILL_SWITCH_ENV_VAR]: "0" } });
  assert.match(text, /^1\. Autoscaler: paused\n {3}paused by the kill switch THRONE_ALPHA_AUTOSCALE_ENABLED=0$/m);
  assert.match(text, /: would skip: kill switch off\n$/);
});

test("high machine pressure reports it would skip on pressure", async () => {
  const report = await statusJson({ pressure: { verdict: "at-capacity", pressure: 91, reasons: ["cpu"] } });
  assert.equal(report.prediction, 'would skip: pressure verdict is "at-capacity"');
  assert.equal(report.pressure.holdingSpawns, true);
});

test("an unreadable spawn limiter reports it would skip on cooldown", async () => {
  assert.equal(
    await prediction({ spawnStatePath: court.malformedSpawnStatePath }),
    `would skip: Alpha spawn limiter state is malformed at ${court.malformedSpawnStatePath}`,
  );
});

test("an empty queue reports it would skip with nothing launchable", async () => {
  assert.equal(
    await prediction({ queuePath: court.emptyQueuePath }),
    "would skip: ready queue positively empty",
  );
});

test("a full court reports admission refused at capacity", async () => {
  const report = await statusJson({ pressure: takeMoreWorkAt(50), liveAlphaNames: SEVEN_LIVE_ALPHAS });
  assert.equal(report.prediction, "would skip: admission refused: at-capacity");
  assert.deepEqual([report.slots.capacity, report.slots.live, report.slots.free], [7, 7, 0]);
});

test("a launchable row with free slots reports it would spawn that objective as its Alpha", async () => {
  assert.equal(await prediction({ pressure: takeMoreWorkAt(10) }), "would spawn beta as alpha-beta-01");
});

test("the status lists launchable work in the order the next run would take it", async () => {
  const report = await statusJson();
  assert.deepEqual(
    report.queue.launchable.map((row: { objectiveCode: string; priority: number }) => [row.objectiveCode, row.priority]),
    [["beta", 9], ["alpha", 5]],
  );
  const text = await statusText();
  assert.ok(text.indexOf("1. beta (priority 9) as alpha-beta-01") < text.indexOf("2. alpha (priority 5) as alpha-alpha-01"));
});

test("the status in json carries every section as structured fields", async () => {
  const report = await statusJson({ liveAlphaNames: ["alpha-flying-01"] });
  assert.deepEqual(Object.keys(report), [
    "warning", "viewpoint", "autoscaler", "nextRun", "slots", "pressure", "cooldown", "queue", "prediction", "predictionCaveat",
  ]);
  assert.deepEqual(Object.keys(report.autoscaler), ["running", "configPauseReason", "killSwitchOn", "sweepHoldingLockSince"]);
  assert.deepEqual(Object.keys(report.slots), ["liveAlphas", "live", "capacity", "free", "floor", "floorBreached", "breachDurationMs"]);
  assert.deepEqual(Object.keys(report.pressure), ["verdict", "value", "reasons", "launchBudget", "holdingSpawns"]);
  assert.deepEqual(Object.keys(report.queue), [
    "readyQueue", "readyQueueReasons", "launchable", "notLaunchable", "deferred", "inFlight", "wouldBrief", "wouldRecover", "mutatingTargets",
  ]);
  assert.deepEqual(report.slots.liveAlphas, [{ name: "alpha-flying-01", objectiveCode: "flying" }]);
  assert.deepEqual(report.queue.launchable[0], {
    objectiveCode: "beta",
    priority: 9,
    alphaName: "alpha-beta-01",
    targetRepo: "/srv/repos/beta",
    targetBranch: "main",
    modelHint: "claude/opus",
    sliceless: true,
    shadowless: false,
  });
  assert.deepEqual(report.queue.notLaunchable.map((row: { objectiveCode: string }) => row.objectiveCode), ["gamma", "unready"]);
  assert.deepEqual(report.queue.inFlight, [{ objectiveCode: "flying", alphaName: "alpha-flying-01" }]);
  assert.deepEqual(report.queue.mutatingTargets, ["/srv/worktrees/alpha-flying-01"]);
  assert.deepEqual(report.cooldown, { elapsed: true });
  assert.equal(report.nextRun, null);
});
