import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import {
  buildLaunchArgv,
  buildResumeArgv,
  isPiCodingAgentProcess,
  launcherFamily,
} from "../src/harness-routing/harness.ts";
import { resolveRegistryModel } from "../src/harness-routing/model-registry.ts";
import { HarnessRegistryService } from "../src/shared-policy/harness-registry.service.ts";
import { PI_PROVIDER_STAND_IN_MARKER } from "./support/pi-provider-stand-in/pi-provider-stand-in.mjs";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const THRONE_CLI = path.join(REPO_ROOT, "bin", "throne-cli");
const SESSION_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const SESSION_FOLDER = "/ledger/shadow-pi/pi-sessions";

const scratchFolders: string[] = [];

after(async () => {
  await Promise.all(scratchFolders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function isolatedThroneHome(configText: string): Promise<NodeJS.ProcessEnv> {
  const scratch = await mkdtemp(path.join(tmpdir(), "pi-harness-test-"));
  scratchFolders.push(scratch);
  await mkdir(path.join(scratch, "home", "config"), { recursive: true });
  await mkdir(path.join(scratch, "live"), { recursive: true });
  await writeFile(path.join(scratch, "home", "config", "config.user.ts"), configText);
  return { ...process.env, THRONE_DATA_HOME: path.join(scratch, "home"), THRONE_LIVE_ROOT: path.join(scratch, "live") };
}

async function throneCli(argumentsList: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await runFile(THRONE_CLI, argumentsList, { env: environment, encoding: "utf8" });
    return result.stdout + result.stderr;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
}

function presetNaming(pair: string): string {
  return [
    "export default {",
    "  steering: {",
    "    activePlanPresetName: 'Evidence',",
    `    customPlanPresets: { Evidence: { alpha: [${pair}], shadow: [${pair}], shadowSlice99: [${pair}] } },`,
    `    stagerPool: [${pair}],`,
    `    regentRoute: ${pair},`,
    "    roleEfforts: { alpha: 3, shadow: 3, shadowSlice99: 3, stager: 3, regent: 3 },",
    "  },",
    "};",
    "",
  ].join("\n");
}

test("naming a Claude or GPT model with the pi harness is refused, saying only DeepSeek models run on pi", () => {
  for (const model of ["pi/opus", "pi/gpt-5.6-sol"]) {
    assert.throws(() => resolveRegistryModel(model), /only DeepSeek models run on pi/);
  }
  assert.throws(
    () => buildLaunchArgv({ harness: "pi", model: "opus", effort: 3, piSession: { sessionId: SESSION_ID, sessionDirectory: SESSION_FOLDER } }),
    /only DeepSeek models run on pi/,
  );
});

test("pi with no model named resolves to flash, and pi/pro to pro, both on the pi harness", () => {
  assert.deepEqual(
    [resolveRegistryModel("pi"), resolveRegistryModel("pi/pro"), resolveRegistryModel("flash")].map((entry) => `${entry.harness}/${entry.model}`),
    ["pi/flash", "pi/pro", "pi/flash"],
  );
});

test("a pi launch goes through piy on the deepseek provider with a throne-chosen session id and folder", () => {
  const argv = buildLaunchArgv({
    harness: "pi",
    model: "flash",
    effort: 5,
    piSession: { sessionId: SESSION_ID, sessionDirectory: SESSION_FOLDER },
  });
  assert.equal(path.basename(argv[0]!), "piy");
  assert.equal(launcherFamily("pi", "flash"), "piy");
  assert.deepEqual(argv.slice(1), [
    "--provider", "deepseek", "--model", "deepseek-flash", "--thinking", "max",
    "--session-id", SESSION_ID, "--session-dir", SESSION_FOLDER,
  ]);
});

test("a pi resume reopens the recorded session by id in the same folder", () => {
  const argv = buildResumeArgv(
    { harness: "pi", model: "pro", effort: 1, piSession: { sessionId: "ignored", sessionDirectory: SESSION_FOLDER } },
    SESSION_ID,
  );
  assert.deepEqual(argv.slice(1), [
    "--provider", "deepseek", "--model", "deepseek-v4-pro", "--thinking", "low",
    "--session", SESSION_ID, "--session-dir", SESSION_FOLDER,
  ]);
});

test("a bun process running pi's package is recognised as pi, and another package's is not", () => {
  assert.equal(
    isPiCodingAgentProcess({ name: "bun", argv: ["/opt/bun", "/vendor/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"] }),
    true,
  );
  assert.equal(
    isPiCodingAgentProcess({ name: "bun", argv: ["/opt/bun", "/home/user/.bun/install/global/node_modules/@another-vendor/pi-coding-agent/dist/cli.js"] }),
    false,
  );
});

test("list-harnesses-and-models shows a pi section holding exactly flash and pro", () => {
  const pi = new HarnessRegistryService().entries().find((entry) => entry.harness === "pi");
  assert.deepEqual(pi?.models.map((model) => `${model.model} ${model.launcher}`), ["flash piy", "pro piy"]);
});

test("a steering preset naming pi/flash for every role passes check-config, as the same preset naming claude/opus does", async () => {
  for (const pair of ["{ harness: 'pi', model: 'flash' }", "{ harness: 'claude', model: 'opus' }"]) {
    const output = await throneCli(["check-config"], await isolatedThroneHome(presetNaming(pair)));
    const named = pair.includes("pi") ? "pi/flash" : "claude/opus";
    assert.match(output, /loaded and validated/, output);
    for (const role of ["Alpha", "Shadow", "Stager", "Regent"]) {
      assert.match(output, new RegExp(`^${role}: ${named} `, "m"), output);
    }
  }
});

test("the provider stand-in is absent from the built dist", async () => {
  assert.notEqual((await readFile(path.join(REPO_ROOT, "dist", "src", "tools.js"), "utf8")).length, 0);
  const grep = await runFile("grep", ["-rl", PI_PROVIDER_STAND_IN_MARKER, path.join(REPO_ROOT, "dist")]).then(
    (result) => result.stdout,
    (error: { code?: number; stdout?: string }) => (error.code === 1 ? "" : `grep failed: ${error.stdout ?? ""}`),
  );
  assert.equal(grep, "");
});
