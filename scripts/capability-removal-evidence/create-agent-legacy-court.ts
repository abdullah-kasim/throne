import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCreateAgent } from "../../src/create-agent-legacy/create.ts";
import { baseDeps } from "../../src/create-agent/policy-test-fixtures.ts";
import { writeSpawnSpec } from "../../src/create-agent-legacy/legacy-spawn-data-contracts.ts";
import type { CreateAgentDeps } from "../../src/create-agent-legacy/create.types.ts";
import { AgentResolutionError } from "../../src/create-agent-legacy/legacy-herdr-identity-contracts.ts";

const THE_LAUNCH_IS_WHERE_THIS_COURT_STOPS = "the court stops at the launch";

const launchArguments: string[][] = [];
const stdout: string[] = [];
const stderr: string[] = [];
const dataHome = process.env.THRONE_DATA_HOME ?? "";

const FULL_USAGE = {
  source: "api",
  as_of: "2026-08-10T00:00:00.000Z",
  windows: [
    { cap_window: "weekly", used_pct: 0, remaining_pct: 100 },
    { cap_window: "5h", used_pct: 0, remaining_pct: 100 },
  ],
};

const legacyOverrides: Partial<CreateAgentDeps> = {
  getClaudeUsage: (async () => ({ ...FULL_USAGE, harness: "claude" })) as unknown as CreateAgentDeps["getClaudeUsage"],
  getOpenCodeGoUsage: (async () => ({ ...FULL_USAGE, harness: "opencode" })) as unknown as CreateAgentDeps["getOpenCodeGoUsage"],
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
};
const deps = { ...(baseDeps() as unknown as CreateAgentDeps), ...legacyOverrides };

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
