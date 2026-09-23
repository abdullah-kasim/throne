import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { run } from "../src/add-to-queue/add-to-queue-runtime.ts";
import { IdentityLineReadStatus } from "../src/agentdata/identity-data.service.ts";
import { openRegentQueueStore } from "../src/regent-queue/regent-queue.store.ts";
import { bypassFlagsAuthorizedInRegistries } from "../src/alpha-autoscale/authorized-bypass-flags.ts";
import { resolveModelBypassAuthorization } from "../src/create-agent/model-bypass-authorization.ts";
import { recordFiledModelHintAuthorizations } from "../src/create-agent/filed-model-hint-authorization.ts";
import { writeModelAllowlist, readModelAllowlist } from "../src/create-agent/model-allowlist.ts";
import { planRolePool } from "../src/config.ts";

const scratchDirectories: string[] = [];
after(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "throne-filed-hint-"));
  scratchDirectories.push(directory);
  return directory;
}

const filedAt = Date.parse("2026-09-23T03:00:00Z");
const checkedAt = "2026-09-24T03:00:00Z";

async function fileRow(dataDir: string, objectiveCode: string, modelHint: string | undefined) {
  const exitCode = await run(
    [
      "--target-repo", join(dataDir, "repo"),
      "--objective-code", objectiveCode,
      ...(modelHint === undefined ? [] : ["--model-hint", modelHint]),
      "--sliceless",
      "Say hi to the Stager",
    ],
    {
      openStore: () => openRegentQueueStore(join(dataDir, "regent-queue.sqlite3")),
      currentAgentName: async () => "stager-test",
      readRole: async () => ({ status: IdentityLineReadStatus.Found, value: "Stager" }),
      resolveLaunchDefaults: () => ({ targetRepo: join(dataDir, "repo"), targetBranch: "main", baseCommit: "0".repeat(40) }),
      now: () => filedAt,
      recordModelHintAuthorizations: (options) => recordFiledModelHintAuthorizations({ ...options, dataDir }),
    },
  );
  assert.equal(exitCode, 0);
}

function readRegistries(dataDir: string) {
  return {
    modelRegistry: JSON.parse(readFileSync(join(dataDir, "regent", "bypass-model-authorizations.json"), "utf8")),
    usageRegistry: JSON.parse(readFileSync(join(dataDir, "regent", "bypass-usage-authorizations.json"), "utf8")),
  };
}

for (const model of ["opus", "fable"]) {
  test(`a claude/${model} hint lets the autoscaler pass both bypass flags for the Alpha and a derived gate Shadow`, async () => {
    const dataDir = scratchDirectory();
    const objectiveCode = `hint${model}`;
    await fileRow(dataDir, objectiveCode, `claude/${model}`);
    const registries = readRegistries(dataDir);
    for (const recipient of [`alpha-${objectiveCode}-01`, `shadow-${objectiveCode}-99a`]) {
      assert.deepEqual(
        bypassFlagsAuthorizedInRegistries(registries, objectiveCode, recipient, checkedAt),
        ["--bypass-model", "--bypass-usage"],
      );
    }
    assert.equal(
      resolveModelBypassAuthorization({
        registry: registries.modelRegistry,
        objectiveCode,
        recipient: `shadow-${objectiveCode}-parser`,
        recipientRole: "Shadow",
        now: checkedAt,
      }).kind,
      "authorized",
    );
    assert.deepEqual(
      bypassFlagsAuthorizedInRegistries(registries, "someoneelse", "alpha-someoneelse-01", checkedAt),
      [],
    );
  });
}

test("a hint already in the Alpha pool writes no authorization", async () => {
  const dataDir = scratchDirectory();
  const pooled = planRolePool("Alpha")[0]!;
  await fileRow(dataDir, "hintpooled", `${pooled.harness}/${pooled.model}`);
  assert.equal(existsSync(join(dataDir, "regent", "bypass-model-authorizations.json")), false);
  assert.equal(existsSync(join(dataDir, "regent", "bypass-usage-authorizations.json")), false);
});

test("filing the same objective twice keeps one entry and leaves the Regent's hand-written entries alone", async () => {
  const dataDir = scratchDirectory();
  mkdirSync(join(dataDir, "regent"), { recursive: true });
  const handWritten = {
    authorizer: "Regent",
    objective_code: "older",
    recipient: "alpha-older-01",
    evidence_locator: "Regent by hand",
    expires_at: "2026-10-01T00:00:00Z",
  };
  writeFileSync(
    join(dataDir, "regent", "bypass-usage-authorizations.json"),
    JSON.stringify({ version: 1, authorizations: [handWritten] }),
  );
  for (const _ of [1, 2]) {
    await recordFiledModelHintAuthorizations({
      objectiveCode: "twice",
      queueItemId: "row-twice",
      modelHint: { harness: "claude", model: "opus" },
      now: filedAt,
      dataDir,
    });
  }
  const { usageRegistry, modelRegistry } = readRegistries(dataDir);
  assert.deepEqual(usageRegistry.authorizations[0], handWritten);
  assert.equal(usageRegistry.authorizations.length, 2);
  assert.equal(modelRegistry.authorizations.length, 1);
  assert.equal(modelRegistry.authorizations[0].expires_at, "2026-10-23T03:00:00.000Z");
});

test("an exact hand-written entry still decides its own recipient over the objective-wide entry", async () => {
  const dataDir = scratchDirectory();
  await recordFiledModelHintAuthorizations({
    objectiveCode: "exact",
    queueItemId: "row-exact",
    modelHint: { harness: "claude", model: "opus" },
    now: filedAt,
    dataDir,
  });
  const { modelRegistry } = readRegistries(dataDir);
  modelRegistry.authorizations.push({
    authorizer: "Lord",
    objective_code: "exact",
    recipient: "alpha-exact-01",
    evidence_locator: "expired by hand",
    expires_at: "2026-09-01T00:00:00Z",
  });
  assert.equal(
    resolveModelBypassAuthorization({
      registry: modelRegistry,
      objectiveCode: "exact",
      recipient: "alpha-exact-01",
      recipientRole: "Alpha",
      now: checkedAt,
    }).kind,
    "refuse",
  );
});

test("the Alpha's campaign allowlist carries its model hint beside the role pool", async () => {
  const dataDir = scratchDirectory();
  await writeModelAllowlist({
    role: "Alpha",
    name: "alpha-listed-01",
    supervisor: "Regent",
    objectiveContract: { kind: "campaign", objectiveCode: "listed" },
    modelHint: { harness: "claude", model: "opus" },
    dataDir,
  });
  const pairs = await readModelAllowlist("alpha-listed-01", dataDir);
  assert.ok(pairs?.some((pair) => pair.harness === "claude" && pair.model === "opus"));
  for (const pooled of planRolePool("Shadow")) {
    assert.ok(pairs?.some((pair) => pair.harness === pooled.harness && pair.model === pooled.model));
  }
});
