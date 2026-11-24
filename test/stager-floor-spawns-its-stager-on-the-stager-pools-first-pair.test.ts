import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { DESIRED_STATES } from "../src/regent-state/regent-state.service.ts";
import {
  ensureLiveStager,
  type StagerFloorDependencies,
} from "../src/alpha-autoscale/stager-floor.ts";
import { makeScratchDirectory } from "../src/scratch-directory.test-support.ts";

const runFile = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
function fakeDependenciesRecordingArgv(recorded: string[][]): StagerFloorDependencies {
  return {
    readDesiredState: async () => DESIRED_STATES.RUNNING,
    readRoster: async () => [],
    readForkedAgentNames: async () => new Set<string>(),
    resolvePublishedRuntime: () => ({
      repoRoot: "/fake/throne",
      cliEntrypoint: "/fake/throne/dist/src/tools.js",
    }),
    invokeCli: async (_executablePath, argv) => {
      recorded.push([...argv]);
      return {
        outcome: "success",
        result: { exitCode: 0, stdout: "/fake/worktree\n", stderr: "" },
      };
    },
    log: () => {},
  };
}

async function floorCreateAgentArguments(): Promise<string[]> {
  const recorded: string[][] = [];
  const decision = await ensureLiveStager(fakeDependenciesRecordingArgv(recorded));
  assert.equal(decision.action, "ensure");
  const createAgentArgv = recorded.find((argv) => argv.includes("create-agent"));
  assert.ok(createAgentArgv, "the floor never invoked create-agent");
  return createAgentArgv.slice(createAgentArgv.indexOf("create-agent") + 1);
}

async function resolveUnderStagerPool(
  createAgentArguments: string[],
  stagerPool: string,
): Promise<{ harness: string; model: string }> {
  const scratch = await makeScratchDirectory("stager-floor-pool-test-");
  await mkdir(path.join(scratch, "home", "config"), { recursive: true });
  await mkdir(path.join(scratch, "live"), { recursive: true });
  await writeFile(
    path.join(scratch, "home", "config", "config.user.ts"),
    `export default { steering: { stagerPool: ${stagerPool} } };\n`,
  );
  const resolver = [
    `import { prepareCreateAgentRequest } from ${JSON.stringify(path.join(REPO_ROOT, "src/create-agent/request.ts"))};`,
    `import { baseDeps } from ${JSON.stringify(path.join(REPO_ROOT, "src/create-agent/policy-test-fixtures.ts"))};`,
    "const result = await prepareCreateAgentRequest(JSON.parse(process.env.FLOOR_ARGUMENTS), baseDeps({ writeStderr: (text) => process.stderr.write(text) }), process.env.FLOOR_SCRATCH);",
    "if (!result.ok) process.exit(3);",
    "process.stdout.write(JSON.stringify({ harness: result.value.harness, model: result.value.model }));",
  ].join("\n");
  const resolverPath = path.join(scratch, "resolve.ts");
  await writeFile(resolverPath, resolver);
  const { stdout } = await runFile(process.execPath, [resolverPath], {
    env: {
      ...process.env,
      THRONE_DATA_HOME: path.join(scratch, "home"),
      THRONE_LIVE_ROOT: path.join(scratch, "live"),
      FLOOR_ARGUMENTS: JSON.stringify(createAgentArguments),
      FLOOR_SCRATCH: scratch,
    },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

test("the autoscale floor names no model so create-agent takes the Stager pool's first pair", async () => {
  const createAgentArgv = await floorCreateAgentArguments();
  assert.equal(createAgentArgv.includes("--model"), false);
  assert.equal(createAgentArgv.some((argument) => /fable|opus/i.test(argument)), false);
});

test("the autoscale floor's Stager starts on the Stager pool's first pair even when that pair is not opus", async () => {
  const resolved = await resolveUnderStagerPool(
    await floorCreateAgentArguments(),
    "[{ harness: 'pi', model: 'flash' }, { harness: 'claude', model: 'opus' }]",
  );
  assert.deepEqual(resolved, { harness: "pi", model: "flash" });
});
