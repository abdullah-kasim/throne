import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_NAMES } from "../src/harness-routing/harness.ts";
import { DESIRED_STATES } from "../src/regent-state/regent-state.service.ts";
import {
  ensureLiveStager,
  type StagerFloorDependencies,
} from "../src/alpha-autoscale/stager-floor.ts";

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

test("the autoscale floor spawns its Stager on fable, the pool's first pair", async () => {
  const recorded: string[][] = [];
  const decision = await ensureLiveStager(fakeDependenciesRecordingArgv(recorded));

  assert.equal(decision.action, "ensure");
  const createAgentArgv = recorded.find((argv) => argv.includes("create-agent"));
  assert.ok(createAgentArgv, "the floor never invoked create-agent");
  const modelFlagIndex = createAgentArgv.indexOf("--model");
  assert.equal(createAgentArgv[modelFlagIndex + 1], MODEL_NAMES.FABLE);
  assert.notEqual(createAgentArgv[modelFlagIndex + 1], MODEL_NAMES.OPUS);
});
