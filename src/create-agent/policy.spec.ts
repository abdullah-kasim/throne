import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { resolveSpawnPolicy } from "./policy.ts";
import { baseDeps, baseRequest } from "./policy-test-fixtures.ts";

const EXCLUDED_PAIR = {
  harness: HARNESS_NAMES.CODEX,
  model: "gpt-5.6-sol",
} as const;

function modelBypassAuthorization() {
  return {
    version: 1 as const,
    authorizations: [
      {
        authorizer: "Regent" as const,
        objective_code: "brg",
        recipient: "shadow-brg-test-01",
        evidence_locator: "test-model-bypass",
        expires_at: "2030-01-01T00:00:00.000Z",
      },
    ],
  };
}

test("an owner allowlist refusal tells the Alpha why bypass flags cannot admit an excluded pair", async () => {
  const request = baseRequest({
    harness: EXCLUDED_PAIR.harness,
    model: EXCLUDED_PAIR.model,
    launchHarness: EXCLUDED_PAIR.harness,
    launchModel: EXCLUDED_PAIR.model,
    flags: {
      supervisor: "alpha-brg-model-allowlist",
      "bypass-model": true,
      "bypass-usage": true,
    },
  });
  const errors: string[] = [];
  const deps = baseDeps({
    readModelBypassAuthorizations: async () => modelBypassAuthorization(),
    writeStderr: (text) => errors.push(text),
  });

  const noFileResult = await resolveSpawnPolicy(request, deps);
  assert.equal(noFileResult.ok, true);

  const ownerAllowlistResult = await resolveSpawnPolicy(
    request,
    baseDeps({
      readModelBypassAuthorizations: async () => modelBypassAuthorization(),
      readModelAllowlist: async () => [
        { harness: HARNESS_NAMES.CLAUDE, model: "sonnet" },
      ],
      writeStderr: (text) => errors.push(text),
    }),
  );
  assert.equal(ownerAllowlistResult.ok, false);
  const refusal = errors.at(-1) ?? "";
  assert.match(refusal, /campaign model allowlist/);
  assert.match(refusal, /codex\/gpt-5\.6-sol/);
  assert.match(refusal, /claude\/sonnet/);
  assert.ok(
    refusal.includes(
      path.join(
        RUNTIME_DATA_DIR,
        "alpha-brg-model-allowlist",
        "model-allowlist.json",
      ),
    ),
  );
  assert.match(refusal, /--bypass-model and every other bypass flag cannot override/);
  assert.match(refusal, /message the Regent to ask why this pair is excluded/);
  assert.match(refusal, /ask permission to add it/);
});
