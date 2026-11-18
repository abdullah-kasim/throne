import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCreateAgent } from "../../src/create-agent/create.ts";
import { baseDeps } from "../../src/create-agent/policy-test-fixtures.ts";
import { writeSpawnSpec } from "../../src/agentdata/spawn-data-contracts.ts";
import type { CreateAgentDeps } from "../../src/create-agent/create.types.ts";
import { AgentResolutionError } from "../../src/herdr/herdr-identity-contracts.ts";

const THE_LAUNCH_IS_WHERE_THIS_COURT_STOPS = "the court stops at the launch";

const launchArguments: string[][] = [];
const stdout: string[] = [];
const stderr: string[] = [];
const dataHome = process.env.THRONE_DATA_HOME ?? "";

const deps = baseDeps({
  planPresetName: undefined,
  targetEffort: undefined,
  resolveAgent: (async (agentName: string) => {
    throw new AgentResolutionError(agentName, 0);
  }) as unknown as CreateAgentDeps["resolveAgent"],
  writeIdentity: async () => {},
  writeOpeningPrompt: async () => {},
  writeSpawnSpec,
  readSpawnSpec: async () => null,
  registrationExists: (async () => false) as unknown as CreateAgentDeps["registrationExists"],
  readTreeBase: async () => null,
  resolveMemoryDir: async () => {
    throw new Error("no memory directory in this court");
  },
  installHerdrOperatorSkill: async (role) => ({ kind: "not-an-operator-role", role }),
  writeStdout: (text) => {
    stdout.push(text);
  },
  writeStderr: (text) => {
    stderr.push(text);
  },
  startAgent: (async (_name: string, options: { argv: string[] }) => {
    launchArguments.push(options.argv);
    throw new Error(THE_LAUNCH_IS_WHERE_THIS_COURT_STOPS);
  }) as unknown as CreateAgentDeps["startAgent"],
});

async function spawnRecordOf(name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(dataHome, "data", name, "spawn.json"), "utf8"));
  } catch {
    return null;
  }
}

const argumentsList = process.argv.slice(2);
const name = argumentsList[argumentsList.indexOf("--name") + 1] ?? "";
let code: number | string;
try {
  code = await runCreateAgent(argumentsList, deps);
} catch (error) {
  code = error instanceof Error ? error.message : String(error);
}
process.stdout.write(
  JSON.stringify({
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    launch_arguments: launchArguments,
    spawn: await spawnRecordOf(name),
  }),
);
