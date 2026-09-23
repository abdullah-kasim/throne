import test from "node:test";
import assert from "node:assert/strict";
import { bypassFlagsAuthorizedInRegistries } from "../src/alpha-autoscale/authorized-bypass-flags.ts";

const now = "2026-09-21T08:00:00Z";
const nextWeek = "2026-09-28T08:00:00Z";
const lastWeek = "2026-09-14T08:00:00Z";

function authorization(authorizer: string, expiresAt: string) {
  return {
    version: 1,
    authorizations: [
    {
      authorizer,
      objective_code: "media139",
      recipient: "alpha-media139-01",
      evidence_locator: "regent-queue row media139 RULINGS",
      expires_at: expiresAt,
    },
    ],
  };
}

test("an Alpha whose objective and name are authorized in both registries launches with both bypass flags", () => {
  assert.deepEqual(
    bypassFlagsAuthorizedInRegistries(
      { modelRegistry: authorization("Lord", nextWeek), usageRegistry: authorization("Regent", nextWeek) },
      "media139",
      "alpha-media139-01",
      now,
    ),
    ["--bypass-model", "--bypass-usage"],
  );
});

test("an Alpha nobody authorized launches with no bypass flag", () => {
  assert.deepEqual(
    bypassFlagsAuthorizedInRegistries(
      { modelRegistry: authorization("Lord", nextWeek), usageRegistry: authorization("Regent", nextWeek) },
      "green139",
      "alpha-green139-01",
      now,
    ),
    [],
  );
});

test("an expired authorization and an unreadable registry both yield no flag", () => {
  assert.deepEqual(
    bypassFlagsAuthorizedInRegistries(
      { modelRegistry: authorization("Lord", lastWeek), usageRegistry: undefined },
      "media139",
      "alpha-media139-01",
      now,
    ),
    [],
  );
});
