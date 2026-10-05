import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STEERING_CONFIG,
  validateSteeringOverride,
} from "../src/steering-user-config.ts";
import { STEERING_SECTION_FIELDS } from "../src/user-config-loader.ts";

const SOURCE = "/checkout/config.user.ts";

test("a Mac carries 5 load per core before refusing work when the setting is absent", () => {
  assert.equal(DEFAULT_STEERING_CONFIG.macLoadPerCoreAtCapacity, 5);
});

test("macLoadPerCoreAtCapacity is a known steering field", () => {
  assert.ok((STEERING_SECTION_FIELDS as readonly string[]).includes("macLoadPerCoreAtCapacity"));
});

test("a positive per-core load limit is accepted as written", () => {
  assert.equal(
    validateSteeringOverride({ macLoadPerCoreAtCapacity: 6.5 }, SOURCE).macLoadPerCoreAtCapacity,
    6.5,
  );
});

test("a per-core load limit that is not a positive finite number is refused at config load", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, true]) {
    assert.throws(
      () => validateSteeringOverride({ macLoadPerCoreAtCapacity: bad }, SOURCE),
      /macLoadPerCoreAtCapacity/,
      `${String(bad)} must be refused`,
    );
  }
});
