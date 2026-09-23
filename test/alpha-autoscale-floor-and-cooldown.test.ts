import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALPHA_AUTOSCALE_BOUNDS } from "../src/alpha-autoscale/alpha-autoscale-bounds.ts";
import {
  ALPHA_AUTOSCALE_SPAWN_INTERVAL_MS,
  readAlphaAutoscaleCooldown,
  recordSuccessfulAlphaAutoscaleSpawn,
} from "../src/alpha-autoscale/alpha-autoscale-schedule-dedupe.ts";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

test("the autoscaler keeps five Alphas live and stops at seven, below the hard maximum of eight", () => {
  assert.equal(ALPHA_AUTOSCALE_BOUNDS.floor, 5);
  assert.equal(ALPHA_AUTOSCALE_BOUNDS.ceiling, 7);
  assert.equal(ALPHA_AUTOSCALE_BOUNDS.hardMaximum, 8);
  assert.ok(
    ALPHA_AUTOSCALE_BOUNDS.ceiling <= ALPHA_AUTOSCALE_BOUNDS.hardMaximum,
  );
});

test("the Alpha spawn cooldown lasts one five-minute worker tick", () => {
  assert.equal(ALPHA_AUTOSCALE_SPAWN_INTERVAL_MS, FIVE_MINUTES_MS);
  const statePath = path.join(
    mkdtempSync(path.join(tmpdir(), "cooldown-")),
    "last-spawn.json",
  );
  recordSuccessfulAlphaAutoscaleSpawn(1_000_000, statePath);
  assert.equal(
    readAlphaAutoscaleCooldown(1_000_000 + FIVE_MINUTES_MS - 1, statePath)
      .elapsed,
    false,
  );
  assert.equal(
    readAlphaAutoscaleCooldown(1_000_000 + FIVE_MINUTES_MS, statePath).elapsed,
    true,
  );
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)
      ? [full]
      : [];
  });
}

test("only the Alpha autoscale worker resets the spawn cooldown, so a Shadow create-agent never does", () => {
  const sourceRoot = path.join(import.meta.dirname, "..", "src");
  const resetters = sourceFiles(sourceRoot)
    .filter((file) =>
      /recordSuccessfulAlphaAutoscaleSpawn|alpha-autoscale-last-spawn/.test(
        readFileSync(file, "utf8"),
      ),
    )
    .map((file) => path.relative(sourceRoot, file))
    .sort();
  assert.deepEqual(resetters, [
    "alpha-autoscale/alpha-autoscale-schedule-dedupe.ts",
    "alpha-autoscale/alpha-autoscale.hosted-worker.ts",
  ]);
});
