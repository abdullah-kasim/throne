import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSpawnSpec, writeSpawnSpec, type SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { SUPERVISOR_LINE_PREFIX } from "../agentdata/identity-data.service.ts";
import { REAPED_DIR_NAME } from "../agentdata/ledger-data.service.ts";
import { checkAgentEvidenceRequirementByName } from "../slice-evidence/agent-evidence-gate.ts";
import { runCreateAgent } from "../create-agent/create.ts";
import { runCreateAgent as runLegacyCreateAgent } from "../create-agent-legacy/create.ts";
import { baseDeps } from "../create-agent/policy-test-fixtures.ts";
import { AgentResolutionError } from "../herdr/herdr-identity-contracts.ts";
import { AgentResolutionError as LegacyAgentResolutionError } from "../create-agent-legacy/legacy-herdr-identity-contracts.ts";
import { singleSliceShadowSpawnRefusal } from "./single-slice-shape.ts";

const ALPHA = "alpha-one-01";
const BUNDLE = "todo-2026-11-04-0100-one";
const EXECUTOR = "shadow-one-01-build";
const CONFORMANCE = "shadow-one-99a-conform-one";
const VERIFY = "shadow-one-99b-verify-one";
const DELIVERY = "shadow-one-99c-deliver-one";
const ORDINARY_BUNDLE_FILES = [
  "00_overview.md",
  "01_build.md",
  "99a_conform_one.md",
  "99b_verify_one.md",
  "99c_deliver_one.md",
  "99d_record_one.md",
];

async function withDataDir(body: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "single-slice-shape-"));
  try {
    await body(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function registerAlpha(dataDir: string, singleSlice: boolean): Promise<void> {
  const spec = {
    harness: "claude",
    model: "opus",
    effort: 3,
    cwd: "/tmp",
    objective_code: "one",
    ...(singleSlice ? { single_slice: true } : {}),
  } as SpawnSpec;
  await writeSpawnSpec(ALPHA, spec, dataDir);
  assert.equal((await readSpawnSpec(ALPHA, dataDir))?.single_slice, singleSlice ? true : undefined);
}

async function writeBundle(dataDir: string, files: readonly string[]): Promise<void> {
  const bundle = path.join(dataDir, ALPHA, BUNDLE);
  await mkdir(bundle, { recursive: true });
  for (const file of files) await writeFile(path.join(bundle, file), "# slice\n");
}

async function registerShadow(dataDir: string, name: string, supervisor = ALPHA): Promise<void> {
  await mkdir(path.join(dataDir, name), { recursive: true });
  await writeFile(path.join(dataDir, name, "identity.md"), `# Identity\n\n${SUPERVISOR_LINE_PREFIX}${supervisor}\n`);
}

async function reapShadow(dataDir: string, name: string): Promise<void> {
  await mkdir(path.join(dataDir, REAPED_DIR_NAME), { recursive: true });
  await rename(path.join(dataDir, name), path.join(dataDir, REAPED_DIR_NAME, name));
}

async function completionRefusal(dataDir: string): Promise<string | undefined> {
  const result = await checkAgentEvidenceRequirementByName(ALPHA, dataDir, async () => ({ ok: true }) as never);
  return result.ok ? undefined : result.detail;
}

function assertNamesTheRuleAndTheLord(message: string | undefined): void {
  assert.ok(message !== undefined, "expected a refusal");
  assert.match(message, /exactly one implementation slice, 01_<task>\.md, worked by one executor Shadow/);
  assert.match(message, /each gate run as its own Shadow distinct from the executor/);
  assert.match(message, /The Lord, 2026-11-04: "a single executor shadow, the 99 verification slices/);
  assert.match(message, /"Best to codify it or alphas tend to ignore"/);
}

type AgentNotFound = new (name: string, matchCount: number) => Error;

async function refusalFromSpawnCommand(
  dataDir: string,
  command: typeof runCreateAgent,
  agentNotFound: AgentNotFound,
): Promise<string> {
  const stderr: string[] = [];
  const code = await command(
    ["--model", "sonnet", "--name", EXECUTOR, "--supervisor", ALPHA, "--role", "Shadow", "--cwd", "/tmp"],
    baseDeps({
      readSpawnSpec: (name) => readSpawnSpec(name, dataDir),
      resolveAgent: (async (name: string) => {
        throw new agentNotFound(name, 0);
      }) as never,
      registrationExists: async () => false,
      refuseSingleSliceShadowSpawn: (shadowName, alphaName) =>
        singleSliceShadowSpawnRefusal(shadowName, alphaName, dataDir),
      writeStderr: (text) => stderr.push(text),
    }),
  );
  assert.equal(code, 1);
  return stderr.join("");
}

test("a single-slice Alpha cannot spawn a Shadow before its bundle exists", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    const message = await refusalFromSpawnCommand(dataDir, runCreateAgent, AgentResolutionError);
    assert.match(message, /^create-agent: refusing Shadow "shadow-one-01-build" under single-slice Alpha "alpha-one-01"/);
    assert.match(message, /it has no todo-\* plan folder yet/);
    assert.match(message, /Nothing was registered or launched\./);
    assertNamesTheRuleAndTheLord(message);
  });
});

test("the legacy spawn command cannot be used to skip the single-slice bundle check", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    const message = await refusalFromSpawnCommand(
      dataDir,
      runLegacyCreateAgent as unknown as typeof runCreateAgent,
      LegacyAgentResolutionError,
    );
    assert.match(message, /^create-agent-legacy: refusing Shadow "shadow-one-01-build" under single-slice Alpha "alpha-one-01"/);
    assert.match(message, /it has no todo-\* plan folder yet/);
    assertNamesTheRuleAndTheLord(message);
  });
});

test("a single-slice bundle with two implementation slices is refused", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, [...ORDINARY_BUNDLE_FILES, "02_more.md"]);
    const message = await singleSliceShadowSpawnRefusal(EXECUTOR, ALPHA, dataDir);
    assert.match(message ?? "", /holds 2 implementation slices \(01_build\.md, 02_more\.md\)/);
    assertNamesTheRuleAndTheLord(message);
  });
});

test("a single-slice bundle with no implementation slice is refused", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, ORDINARY_BUNDLE_FILES.filter((file) => file !== "01_build.md"));
    const message = await singleSliceShadowSpawnRefusal(EXECUTOR, ALPHA, dataDir);
    assert.match(message ?? "", /holds no implementation slice/);
    assertNamesTheRuleAndTheLord(message);
  });
});

test("a single-slice bundle whose one implementation slice is not numbered 01 is refused", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, [...ORDINARY_BUNDLE_FILES.filter((file) => file !== "01_build.md"), "02_build.md"]);
    const message = await singleSliceShadowSpawnRefusal(EXECUTOR, ALPHA, dataDir);
    assert.match(message ?? "", /its one implementation slice 02_build\.md is not numbered 01/);
  });
});

test("a single-slice bundle missing its 99c file is refused", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, ORDINARY_BUNDLE_FILES.filter((file) => file !== "99c_deliver_one.md"));
    const message = await singleSliceShadowSpawnRefusal(EXECUTOR, ALPHA, dataDir);
    assert.match(message ?? "", /has no 99c_deliver_\*\.md/);
    assert.doesNotMatch(message ?? "", /has no 99d_record/);
    assertNamesTheRuleAndTheLord(message);
  });
});

test("a single-slice bundle of one 01 slice and its four 99 files lets the executor spawn", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, [...ORDINARY_BUNDLE_FILES, "01z_critique_build.md", "98_ticket_one.md"]);
    assert.equal(await singleSliceShadowSpawnRefusal(EXECUTOR, ALPHA, dataDir), undefined);
  });
});

test("a single-slice Alpha cannot spawn its delivery gate before separate conformance and verify Shadows ran", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, ORDINARY_BUNDLE_FILES);
    await registerShadow(dataDir, EXECUTOR);
    await registerShadow(dataDir, CONFORMANCE);
    await registerShadow(dataDir, VERIFY, "alpha-other-01");
    const message = await singleSliceShadowSpawnRefusal(DELIVERY, ALPHA, dataDir);
    assert.match(message ?? "", /shows a separate 99b verify Shadow under it/);
    assert.doesNotMatch(message ?? "", /99a conformance|01 executor/);
    assertNamesTheRuleAndTheLord(message);
    await registerShadow(dataDir, VERIFY);
    assert.equal(await singleSliceShadowSpawnRefusal(DELIVERY, ALPHA, dataDir), undefined);
  });
});

test("a single-slice Alpha cannot complete unless each 99 gate ran as its own Shadow", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, ORDINARY_BUNDLE_FILES);
    await registerShadow(dataDir, EXECUTOR);
    const message = await completionRefusal(dataDir);
    assert.match(message ?? "", /single-slice Alpha "alpha-one-01" cannot complete/);
    assert.match(
      message ?? "",
      /a separate 99a conformance Shadow, a separate 99b verify Shadow, a separate 99c delivery Shadow/,
    );
    assertNamesTheRuleAndTheLord(message);
    for (const gate of [CONFORMANCE, VERIFY, DELIVERY]) await registerShadow(dataDir, gate);
    assert.equal(await completionRefusal(dataDir), undefined);
  });
});

test("a gate Shadow archived by reaping still counts", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, ORDINARY_BUNDLE_FILES);
    for (const shadow of [EXECUTOR, `${EXECUTOR}-r2`, CONFORMANCE, VERIFY, DELIVERY]) {
      await registerShadow(dataDir, shadow);
      await reapShadow(dataDir, shadow);
    }
    assert.equal(await completionRefusal(dataDir), undefined);
  });
});

test("an ordinary Alpha is untouched by the single-slice checks", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, false);
    await writeBundle(dataDir, ["00_overview.md", "01_a.md", "02_b.md"]);
    assert.equal(await singleSliceShadowSpawnRefusal(EXECUTOR, ALPHA, dataDir), undefined);
    assert.equal(await singleSliceShadowSpawnRefusal(DELIVERY, ALPHA, dataDir), undefined);
    assert.equal(await completionRefusal(dataDir), undefined);
  });
});

test("a verify Shadow addressed only by its 99b number can spawn once the executor and conformance Shadows ran", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, ORDINARY_BUNDLE_FILES);
    await registerShadow(dataDir, EXECUTOR);
    await registerShadow(dataDir, CONFORMANCE);
    assert.equal(await singleSliceShadowSpawnRefusal("shadow-one-99b", ALPHA, dataDir), undefined);
  });
});

test("a delivery Shadow addressed only by its 99c number is still held to the separate gate Shadows", async () => {
  await withDataDir(async (dataDir) => {
    await registerAlpha(dataDir, true);
    await writeBundle(dataDir, ORDINARY_BUNDLE_FILES);
    await registerShadow(dataDir, EXECUTOR);
    const message = await singleSliceShadowSpawnRefusal("shadow-one-99c", ALPHA, dataDir);
    assert.match(message ?? "", /a separate 99a conformance Shadow, a separate 99b verify Shadow under it/);
    assertNamesTheRuleAndTheLord(message);
  });
});
