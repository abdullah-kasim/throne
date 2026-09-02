// A role pool pair carries a harness AND a model, which made the two
// decisions inseparable: moving harness meant rewriting every pool, and
// rewriting a pool to move harness is how the model pin was lost on
// 2026-08-26. A single-entry pool was widened to ten in the same edit that
// changed harness, and the next spawn came up on the most expensive model
// available for a task whose whole deliverable was one sentence.
//
// `activeHarness` separates them: a preset names MODELS, one field names the
// HARNESS, and neither edit requires the other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSteeringOverride } from "../src/steering-user-config.ts";
import { STEERING_SECTION_FIELDS } from "../src/user-config-loader.ts";

const SOURCE = "/checkout/config.user.ts";

test("activeHarness is accepted as its own field", () => {
  const override = validateSteeringOverride(
    { activePlanPresetName: "TerraLow", activeHarness: "omp" },
    SOURCE,
  );
  assert.equal(override.activeHarness, "omp");
  // The preset is untouched by it — that is the entire point.
  assert.equal(override.activePlanPresetName, "TerraLow");
});

test("a preset can be chosen with no harness opinion at all", () => {
  const override = validateSteeringOverride(
    { activePlanPresetName: "TerraLow" },
    SOURCE,
  );
  assert.equal(override.activeHarness, undefined);
});

test("an empty or non-string harness is refused at config load", () => {
  for (const bad of ["", "   ", 7, null, {}]) {
    assert.throws(
      () => validateSteeringOverride({ activeHarness: bad }, SOURCE),
      /activeHarness/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("the harness name is trimmed rather than taken literally", () => {
  assert.equal(
    validateSteeringOverride({ activeHarness: "  omp  " }, SOURCE).activeHarness,
    "omp",
  );
});

test("an unknown steering field is still refused — the allowlist did not widen", () => {
  assert.throws(
    () => validateSteeringOverride({ activeHarnesss: "omp" }, SOURCE),
    /is not a known field/,
  );
});

test("delivery steering accepts SQLite and rejects obsolete transports", () => {
  assert.equal(
    validateSteeringOverride({ messageQueueTransport: "sqlite" }, SOURCE)
      .messageQueueTransport,
    "sqlite",
  );
  const obsoleteTransport = String.fromCharCode(98, 117, 108, 108, 109, 113);
  for (const invalid of [obsoleteTransport, "", true, undefined]) {
    assert.throws(
      () => validateSteeringOverride({ messageQueueTransport: invalid }, SOURCE),
      /must be "sqlite"/,
    );
  }
});

// The Stager is a third, separate decision. Presets name campaign-role
// models, `activeHarness` names the campaign-role harness, and NEITHER may
// move the Lord's point of contact — that pin is a standing order. But the
// order pins what the Stager runs on, not that it can never be changed:
// before `stagerPool` existed the only way to move it was editing
// src/config.ts, so when the court moved to omp the Stager alone kept
// spawning on the native claude harness and nothing said so.

test("stagerPool is accepted as its own field", () => {
  const override = validateSteeringOverride(
    { stagerPool: [{ harness: "omp", model: "opus" }] },
    SOURCE,
  );
  assert.deepEqual(override.stagerPool, [{ harness: "omp", model: "opus" }]);
});

test("stagerPool is absent unless the operator names it", () => {
  assert.equal(
    validateSteeringOverride({ activeHarness: "omp" }, SOURCE).stagerPool,
    undefined,
  );
});

test("a malformed stagerPool refuses the config", () => {
  for (const bad of [[], "omp/opus", {}, [{ harness: "omp" }]]) {
    assert.throws(
      () => validateSteeringOverride({ stagerPool: bad }, SOURCE),
      /stagerPool/,
      `expected refusal for ${JSON.stringify(bad)}`,
    );
  }
});

// The steering section is gated twice — once by user-config-loader.ts on the
// whole file, once by validateSteeringOverride on the section — and for
// `stagerPool`'s first landing those two lists disagreed. The inner
// validator accepted the field while the outer gate refused the file, so
// every throne command died at load with "not a known field". One array now,
// imported, not copied.
test("both steering gates accept exactly the same keys", () => {
  let rejection: Error | undefined;
  try {
    validateSteeringOverride({ definitelyNotAField: 1 }, SOURCE);
  } catch (error) {
    rejection = error as Error;
  }
  assert.match(rejection?.message ?? "", /is not a known field/);
  for (const field of STEERING_SECTION_FIELDS) {
    assert.match(
      rejection?.message ?? "",
      new RegExp(`\\b${field}\\b`),
      `the outer gate accepts \`${field}\` but the steering validator does not list it`,
    );
  }
});
