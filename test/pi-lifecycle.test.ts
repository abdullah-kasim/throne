import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { SpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";
import type { StartOptions } from "../src/herdr/herdr-create.contracts.ts";
import { harnessProcessOf, isRegisteredHarnessProcess } from "../src/herdr/herdr-process-detection.ts";
import { terminateWorktreeProcesses } from "../src/reap-agent/process-teardown.ts";
import {
  piSessionDirectory,
  resumeOrphan,
  type StartupResumeContract,
} from "../src/throne-startup/throne-startup-reconciliation.service.ts";

const SESSION_ID = "5b1d7a3e-2c4f-4e8a-9b6d-0a1c2e3f4d5b";
const PI_CLI_PATH = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

function resumeCourt(record: SpawnSpec, cwdExists = true) {
  const launches: StartOptions[] = [];
  const prompts: string[] = [];
  const contract: StartupResumeContract = {
    readSpawnSpec: async () => record,
    resumeRegisteredAgentInRestoredTab: async (_name, options) => {
      launches.push(options);
      return { kind: "new-tab-launched" };
    },
    deliverOpeningPrompt: async (_name, prompt) => {
      prompts.push(prompt);
    },
    pathExists: async () => cwdExists,
    throneRoot: tmpdir(),
    readAccountsConfig: () => null,
    readAgentRole: async () => undefined,
    preparePiLaunch: async (_name, _family, recorded) => ({
      ready: true,
      launch: {
        piSession: { sessionId: recorded?.session_id ?? SESSION_ID, sessionDirectory: "" },
        piModelId: recorded?.pi_model_id ?? "deepseek-v4-flash",
        displayName: null,
        account: "deepseekpay",
        note: null,
        env: {},
      },
    }),
    log: () => {},
    warn: () => {},
  };
  return { contract, launches, prompts };
}

function piRecord(): SpawnSpec {
  return { harness: "pi", model: "flash", effort: 2, cwd: tmpdir(), session_id: SESSION_ID, pi_model_id: "deepseek-v4-flash" };
}

function argumentAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

test("P6.1 a pi agent whose harness died is relaunched into its recorded pi session in its own session folder", async () => {
  const court = resumeCourt(piRecord());
  await resumeOrphan("shadow-pi-restart", court.contract);
  const argv = court.launches[0]!.argv;
  assert.equal(argumentAfter(argv, "--session"), SESSION_ID);
  assert.equal(argumentAfter(argv, "--session-dir"), piSessionDirectory("shadow-pi-restart"));
  assert.equal(argumentAfter(argv, "--provider"), "deepseek");
  assert.equal(argumentAfter(argv, "--model"), "deepseek-v4-flash");
  assert.equal(argv.includes("--session-id"), false);
  assert.match(court.prompts[0]!, /EXACT previous native pi session/);
});

test("P6.1 a pi agent whose worktree is gone is relaunched with a fresh pi session in its own session folder", async () => {
  const court = resumeCourt(piRecord(), false);
  await resumeOrphan("shadow-pi-moved", court.contract);
  const argv = court.launches[0]!.argv;
  const freshId = argumentAfter(argv, "--session-id");
  assert.ok(freshId !== undefined && freshId !== SESSION_ID);
  assert.equal(argumentAfter(argv, "--session-dir"), piSessionDirectory("shadow-pi-moved"));
});

test("P6.2 reaping a pi Shadow terminates the pi process running inside its worktree", async () => {
  const worktree = await mkdtemp(path.join(tmpdir(), "pi-reap-"));
  try {
    const cli = path.join(worktree, PI_CLI_PATH);
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "setInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [cli], { cwd: worktree, stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await terminateWorktreeProcesses(worktree);
    await exited;
    assert.ok(result.killed.some((entry) => entry.pid === child.pid && entry.cmdline.includes("pi-coding-agent")));
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("P6.3 a pane running pi under bun counts as a live pi harness for start-up reconciliation", () => {
  const piProcess = { name: "bun", argv: ["/home/u/.throne/bun", `/throne/vendor/${PI_CLI_PATH}`, "--provider", "deepseek"], pid: 77 };
  assert.equal(harnessProcessOf({ paneId: "p", foregroundProcesses: [piProcess] }), piProcess);
  assert.equal(isRegisteredHarnessProcess("pi", piProcess), true);
  assert.equal(isRegisteredHarnessProcess("claude", piProcess), false);
});
