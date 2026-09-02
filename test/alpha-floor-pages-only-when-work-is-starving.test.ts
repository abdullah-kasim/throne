// The Lord's ruling, 2026-08-25: "autoscaler should never alarm if there was
// no alpha launched by it." The floor paged on every tick of a shortfall the
// Regent had created deliberately — five objectives held out of the ready
// queue behind a spike gate — while the autoscaler behaved correctly at every
// step. These tests pin which endings stay loud, because the failure mode of
// getting this wrong is a silent alarm, not a noisy one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldPageFloorBreach } from "../src/alpha-autoscale/alpha-floor-notify.ts";
import type { AlphaFloorBreachSnapshot } from "../src/alpha-autoscale/alpha-floor-breach-snapshot.ts";

const BASE = { liveAlphaCount: 2, floorMinimum: 4, breachDurationMs: 900_000 };

function skip(
  reason: string,
  noLaunchableWork: boolean,
): AlphaFloorBreachSnapshot {
  return {
    ...BASE,
    decision: { action: "skip", reason, floorBreached: true, noLaunchableWork },
  };
}

test("an empty ready queue is silent — the shortfall is not the autoscaler's to fix", () => {
  // Tonight's exact tick, three times an hour, forever.
  assert.equal(
    shouldPageFloorBreach(skip("ready queue positively empty", true)),
    false,
  );
});

test("a successful spawn is silent — the autoscaler closed the gap itself", () => {
  assert.equal(
    shouldPageFloorBreach({
      ...BASE,
      decision: {
        action: "spawn",
        candidate: { objectiveCode: "abc" } as never,
        floorOverride: true,
      },
      spawnOutcome: { kind: "spawned" },
    }),
    false,
  );
});

test("a FAILED spawn stays loud — an objective is unclaimed and nothing else says so", () => {
  assert.equal(
    shouldPageFloorBreach({
      ...BASE,
      decision: {
        action: "spawn",
        candidate: { objectiveCode: "abc" } as never,
        floorOverride: true,
      },
      spawnOutcome: { kind: "failed", stage: "create-agent", detail: "boom" },
    }),
    true,
  );
});

test("a spawn decision reporting no outcome stays loud — silencing it would hide a caller bug", () => {
  assert.equal(
    shouldPageFloorBreach({
      ...BASE,
      decision: {
        action: "spawn",
        candidate: { objectiveCode: "abc" } as never,
        floorOverride: true,
      },
    }),
    true,
  );
});

test("every refusal WITH launchable work waiting stays loud — that is starvation", () => {
  for (const reason of [
    'pressure verdict is "at-capacity"',
    "ready queue unknown: store unreadable",
    "ready queue ineligible: missing base commit",
    "kill switch off",
    "cooldown not yet elapsed since last spawn",
    'duplicate: objective "abc" already delivered by "alpha-abc-x"',
    "admission refused: ceiling reached",
  ]) {
    assert.equal(
      shouldPageFloorBreach(skip(reason, false)),
      true,
      `"${reason}" must still page`,
    );
  }
});

test("an unresolved launch history stays loud", () => {
  assert.equal(
    shouldPageFloorBreach({
      ...BASE,
      decision: { action: "unresolved", name: "alpha-abc-x", floorBreached: true },
    }),
    true,
  );
});

test("the gate reads the structured flag, not the reason prose", () => {
  // Rewording a human-facing sentence must never silence a page, and must
  // never un-silence one either.
  assert.equal(shouldPageFloorBreach(skip("ready queue positively empty", false)), true);
  assert.equal(shouldPageFloorBreach(skip("some future rewording", true)), false);
});
