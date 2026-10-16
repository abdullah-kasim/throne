import assert from "node:assert/strict";
import { test } from "node:test";
import { desiredAgentSettings } from "../agent-settings/agent-settings-decision.ts";
import { DEFAULT_AGENT_SETTINGS_CONFIG } from "../agent-settings/agent-settings-user-config.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { CreateAgentDeps, PolicyResolution } from "./create.types.ts";
import { resolveSpawnPolicy } from "./policy.ts";
import {
  baseDeps,
  baseRequest,
  SHADOW_NAME,
} from "./policy-test-fixtures.ts";
import { runResidentAgent } from "./resident-agent.ts";

const SESSION_NAME_FLAG = "--name";
const THE_LAUNCH_IS_ALL_THIS_SPEC_WATCHES = "the spec stops at the launch";

interface WatchedLaunch {
  readonly startedAgentNames: string[];
  readonly launchArguments: string[][];
  readonly deps: CreateAgentDeps;
}

function courtThatStopsAtTheLaunch(): WatchedLaunch {
  const startedAgentNames: string[] = [];
  const launchArguments: string[][] = [];
  const deps = baseDeps({
    writeIdentity: async () => {},
    writeOpeningPrompt: async () => {},
    writeSpawnSpec: async () => {},
    readTreeBase: async () => null,
    resolveMemoryDir: async () => {
      throw new Error("no memory directory in this spec");
    },
    installHerdrOperatorSkill: async (role) => ({
      kind: "not-an-operator-role",
      role,
    }),
    writeStderr: () => {},
    startAgent: (async (name: string, options: { argv: string[] }) => {
      startedAgentNames.push(name);
      launchArguments.push(options.argv);
      throw new Error(THE_LAUNCH_IS_ALL_THIS_SPEC_WATCHES);
    }) as unknown as CreateAgentDeps["startAgent"],
  });
  return { startedAgentNames, launchArguments, deps };
}

async function shadowReadyToLaunch(
  deps: CreateAgentDeps,
): Promise<PolicyResolution> {
  const policy = await resolveSpawnPolicy(baseRequest(), deps);
  assert.equal(policy.ok, true);
  return (policy as { value: PolicyResolution }).value;
}

async function argumentsAShadowIsLaunchedWith(): Promise<string[]> {
  const court = courtThatStopsAtTheLaunch();
  const request = await shadowReadyToLaunch(court.deps);
  await assert.rejects(
    runResidentAgent(request, court.deps),
    new RegExp(THE_LAUNCH_IS_ALL_THIS_SPEC_WATCHES),
  );
  assert.deepEqual(court.startedAgentNames, [SHADOW_NAME]);
  assert.equal(court.launchArguments.length, 1);
  return court.launchArguments[0]!;
}

function sessionNameIn(launchArguments: readonly string[]): string | undefined {
  const flagAt = launchArguments.indexOf(SESSION_NAME_FLAG);
  return flagAt < 0 ? undefined : launchArguments[flagAt + 1];
}

test("a Claude Code agent is launched already carrying its session name", async () => {
  const launchArguments = await argumentsAShadowIsLaunchedWith();

  assert.equal(
    launchArguments.filter((argument) => argument === SESSION_NAME_FLAG).length,
    1,
  );
  assert.equal(sessionNameIn(launchArguments), SHADOW_NAME);
});

test("the session name passed at launch is the one the settings check wants", async () => {
  const launchArguments = await argumentsAShadowIsLaunchedWith();
  const wantedByTheSettingsCheck = desiredAgentSettings(
    {
      agentName: SHADOW_NAME,
      role: "Shadow",
      tabName: SHADOW_NAME,
      harness: HARNESS_NAMES.CLAUDE,
    },
    DEFAULT_AGENT_SETTINGS_CONFIG.colourByRole,
  );

  assert.ok(wantedByTheSettingsCheck);
  assert.equal(
    sessionNameIn(launchArguments),
    wantedByTheSettingsCheck.sessionName,
  );
});
