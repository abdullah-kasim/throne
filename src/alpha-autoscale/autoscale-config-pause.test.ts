// Requirement: the operator can pause the whole court's spawning from the
// live `config.user.ts` (`steering.autoscaleEnabled: false`) now that the
// env switch is permanently armed in both service templates (the Lord's
// order of 2026-09-02). A paused tick is INERT -- it skips before auto-brief
// or deferral promotion touch a queue row -- and the pause is read fresh per
// tick, so no backend restart is involved in either direction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AlphaAutoscaleHostedWorker,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import { readAutoscaleEnabledInUserConfig } from "./kill-switch.ts";

function dependencies(
  log: string[],
  touched: string[],
  pause: AlphaAutoscaleDependencies["readAutoscaleEnabledInConfig"],
): AlphaAutoscaleDependencies {
  return {
    log: (message) => log.push(message),
    notifyOfFloorBreach: {
      resolveAgent: async () => {
        touched.push("notify");
        return { paneId: "p" } as never;
      },
      submitToAgent: async () => {},
    },
    promoteDeferredWork: () => {
      touched.push("promoteDeferredWork");
      return { released: [], recovered: null, overriddenAuthority: null };
    },
    notifyOfIdleRecovery: async () => {},
    readPressure: () => ({ verdict: "take-more-work", pressure: 0, reasons: [] }),
    readReadyQueue: () => {
      touched.push("readReadyQueue");
      return { state: "positively-empty" };
    },
    autoBriefEligibleItems: () => {
      touched.push("autoBriefEligibleItems");
      return { state: "staged", count: 0 };
    },
    readKillSwitch: () => true,
    readAutoscaleEnabledInConfig: pause,
    readSpawnCooldown: () => ({ elapsed: true }),
    recordSuccessfulSpawn: () => {},
    readActiveCapacityInputs: async () => ({ activeRecords: [], mutatingTargets: [] }),
    readLaunchLedger: async () => ({ state: "entries", entries: [] }) as never,
    resolvePublishedRuntime: () => undefined,
    invokeCli: async () => {
      throw new Error("must not spawn while paused");
    },
  };
}

test("a paused config makes the tick skip before it touches the queue, and says why", async () => {
  const log: string[] = [];
  const touched: string[] = [];
  const worker = new AlphaAutoscaleHostedWorker(
    dependencies(log, touched, async () => ({ enabled: false, reason: "autoscaler disabled in config.user.ts (steering.autoscaleEnabled: false)" })),
  );
  await worker.runOnce();
  assert.deepEqual(touched, []);
  assert.equal(log.length, 1);
  assert.match(log[0]!, /^skip: autoscaler disabled in config\.user\.ts/);
});

test("an enabled config lets the tick proceed to its ordinary gates", async () => {
  const log: string[] = [];
  const touched: string[] = [];
  const worker = new AlphaAutoscaleHostedWorker(
    dependencies(log, touched, async () => ({ enabled: true })),
  );
  await worker.runOnce();
  assert.ok(touched.includes("autoBriefEligibleItems"));
  assert.ok(touched.includes("readReadyQueue"));
  assert.ok(log.some((line) => line === "skip: ready queue positively empty"));
});

test("a test bag with no pause reader behaves as enabled (absent means ON)", async () => {
  const log: string[] = [];
  const touched: string[] = [];
  const worker = new AlphaAutoscaleHostedWorker(dependencies(log, touched, undefined));
  await worker.runOnce();
  assert.ok(touched.includes("readReadyQueue"));
});

function writeConfig(body: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "autoscale-pause-"));
  // Outside the repo the transpile-only loader has no package "type" to go
  // by and emits CommonJS, whose `__esModule` marker the loader then rejects
  // as an unknown top-level field. The live file sits under the throne's own
  // ESM package.json; give the fixture the same footing.
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  const file = path.join(root, "config.user.ts");
  writeFileSync(file, body);
  return file;
}

test("the fresh reader: false pauses, true and absent enable, a non-boolean pauses with a reason", async () => {
  const off = await readAutoscaleEnabledInUserConfig(
    writeConfig("export default { steering: { autoscaleEnabled: false } };\n"),
  );
  assert.equal(off.enabled, false);
  assert.match((off as { reason: string }).reason, /steering\.autoscaleEnabled: false/);

  const on = await readAutoscaleEnabledInUserConfig(
    writeConfig("export default { steering: { autoscaleEnabled: true } };\n"),
  );
  assert.equal(on.enabled, true);

  const absentField = await readAutoscaleEnabledInUserConfig(
    writeConfig("export default { steering: { activeTargetEffort: 1 } };\n"),
  );
  assert.equal(absentField.enabled, true);

  const absentFile = await readAutoscaleEnabledInUserConfig(
    path.join(mkdtempSync(path.join(tmpdir(), "autoscale-pause-none-")), "config.user.ts"),
  );
  assert.equal(absentFile.enabled, true);

  const wrongType = await readAutoscaleEnabledInUserConfig(
    writeConfig("export default { steering: { autoscaleEnabled: 'no' } };\n"),
  );
  assert.equal(wrongType.enabled, false);
  assert.match((wrongType as { reason: string }).reason, /must be a boolean/);
});

test("the fresh reader re-reads the same path after it changes on disk (no restart needed)", async () => {
  const file = writeConfig("export default { steering: { autoscaleEnabled: true } };\n");
  assert.equal((await readAutoscaleEnabledInUserConfig(file)).enabled, true);
  writeFileSync(file, "export default { steering: { autoscaleEnabled: false } };\n");
  assert.equal((await readAutoscaleEnabledInUserConfig(file)).enabled, false);
  writeFileSync(file, "export default { steering: { autoscaleEnabled: true } };\n");
  assert.equal((await readAutoscaleEnabledInUserConfig(file)).enabled, true);
});

test("an unreadable config pauses rather than spawning blind", async () => {
  const broken = await readAutoscaleEnabledInUserConfig(
    writeConfig("export default { steering: { notAField: 1 } };\n"),
  );
  assert.equal(broken.enabled, false);
  assert.match((broken as { reason: string }).reason, /paused rather than spawning blind/);
});
