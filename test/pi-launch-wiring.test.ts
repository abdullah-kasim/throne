import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { addProviderAccount } from "../src/account/provider-accounts.ts";
import type { SpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";
import { resolveRegistryModel } from "../src/harness-routing/model-registry.ts";
import { PI_KEY_FILE_VARIABLE, type PiLaunchPlaces } from "../src/create-agent/pi-launch.ts";
import type { CreateAgentDeps, PolicyResolution } from "../src/create-agent/create.types.ts";
import { resolveSpawnPolicy } from "../src/create-agent/policy.ts";
import { baseDeps, baseRequest, SHADOW_NAME } from "../src/create-agent/policy-test-fixtures.ts";
import { runResidentAgent } from "../src/create-agent/resident-agent.ts";
import { startPiProviderStandIn } from "./support/pi-provider-stand-in/pi-provider-stand-in.mjs";

const STAND_IN_KEY = "sk-stand-in-key-for-the-launch-wiring";
const LAUNCH_STOPPED = "the test stops at the launch";

const standIn = await startPiProviderStandIn({
  models: [
    { id: "deepseek-v4-flash", object: "model" },
    { id: "deepseek-v5-flash", object: "model", display_name: "DeepSeek-V5-Flash" },
    { id: "deepseek-v4-pro", object: "model" },
  ],
});
const scratch = await mkdtemp(path.join(tmpdir(), "pi-launch-wiring-"));
after(async () => {
  await standIn.close();
  await rm(scratch, { recursive: true, force: true });
});

interface Launch {
  argv: string[];
  env?: Record<string, string>;
}

async function piCourt(label: string, withAccount = true) {
  const folder = path.join(scratch, label);
  const accountsConfigPath = path.join(folder, "config", "accounts.json");
  if (withAccount) {
    const source = path.join(folder, "source-key");
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    await writeFile(source, `${STAND_IN_KEY}\n`);
    await addProviderAccount(
      { name: "deepseekpay", provider: "deepseek", sourceKeyFile: source },
      { configPath: accountsConfigPath, throneHome: folder },
    );
  }
  const places: PiLaunchPlaces = {
    dataDirectory: path.join(folder, "data"),
    accountsConfigPath,
    cacheDirectory: path.join(folder, "cache"),
    providerBaseUrl: standIn.baseUrl,
    settingsOverridesPath: path.join(folder, "config", "pi-settings.json"),
    readOperatorPiSettings: async () => ({}),
    installStateExtensions: async () => {},
  };
  const launches: Launch[] = [];
  const spawnSpecs: SpawnSpec[] = [];
  const output: string[] = [];
  const deps: CreateAgentDeps & { said?: string[] } = baseDeps({
    piLaunchPlaces: places,
    writeIdentity: async () => {},
    writeOpeningPrompt: async () => {},
    writeSpawnSpec: async (_name: string, spec: SpawnSpec) => {
      spawnSpecs.push(spec);
    },
    readTreeBase: async () => null,
    resolveMemoryDir: async () => {
      throw new Error("no memory directory here");
    },
    installHerdrOperatorSkill: async (role) => ({ kind: "not-an-operator-role", role }),
    writeStderr: (text: string) => output.push(text),
    writeStdout: (text: string) => output.push(text),
    startAgent: (async (_name: string, options: Launch) => {
      launches.push(options);
      throw new Error(LAUNCH_STOPPED);
    }) as unknown as CreateAgentDeps["startAgent"],
  } as Partial<CreateAgentDeps>);
  deps.said = output;
  return { deps, launches, spawnSpecs, output, places };
}

async function piShadow(deps: CreateAgentDeps & { said?: string[] }, modelNamed: string): Promise<PolicyResolution> {
  const policy = await resolveSpawnPolicy(baseRequest(), deps);
  assert.equal(policy.ok, true, JSON.stringify(deps.said));
  const entry = resolveRegistryModel(modelNamed);
  return {
    ...(policy as { value: PolicyResolution }).value,
    harness: entry.harness,
    model: entry.model,
    launchHarness: entry.harness,
    launchModel: entry.model,
    account: undefined,
  };
}

function argumentAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function launch(label: string, model: string) {
  const court = await piCourt(label);
  const request = await piShadow(court.deps, model);
  await assert.rejects(runResidentAgent(request, court.deps), new RegExp(LAUNCH_STOPPED));
  return court;
}

test("P1.1 a pi/flash Shadow launches through piy and spawn.json records harness pi, family flash, the exact version and the account", async () => {
  const court = await launch("p11", "pi/flash");
  const argv = court.launches[0]!.argv;
  assert.equal(path.basename(argv[0]!), "piy");
  assert.equal(argumentAfter(argv, "--model"), "deepseek-v5-flash");
  const spec = court.spawnSpecs[0]! as SpawnSpec & Record<string, unknown>;
  assert.equal(spec.harness, "pi");
  assert.equal(spec.model, "flash");
  assert.equal(spec.pi_model_id, "deepseek-v5-flash");
  assert.equal(spec.pi_model_display_name, "DeepSeek-V5-Flash");
  assert.equal(spec.account, "deepseekpay");
  assert.equal(spec.session_id, argumentAfter(argv, "--session-id"));
  const agentDirectory = path.join(court.places.dataDirectory, SHADOW_NAME, "pi-agent");
  assert.match(await readFile(path.join(agentDirectory, "models.json"), "utf8"), new RegExp(standIn.baseUrl));
  assert.ok((await readFile(path.join(agentDirectory, "extensions", "throne-pi-delivery.ts"), "utf8")).length > 0);
  assert.ok(court.output.some((line) => line.includes("deepseek-v5-flash")));
});

test("P1.2 harness pi with no model named launches on flash", async () => {
  const court = await launch("p12", "pi");
  assert.equal(argumentAfter(court.launches[0]!.argv, "--model"), "deepseek-v5-flash");
  assert.equal(court.spawnSpecs[0]!.model, "flash");
});

test("P1.3 pi/pro launches on the newest pro model", async () => {
  const court = await launch("p13", "pi/pro");
  assert.equal(argumentAfter(court.launches[0]!.argv, "--model"), "deepseek-v4-pro");
  assert.equal((court.spawnSpecs[0]! as Record<string, unknown>).pi_model_id, "deepseek-v4-pro");
});

test("P3.2 the key reaches pi only through the pane's environment, never argv or spawn.json", async () => {
  const court = await launch("p32", "pi/flash");
  const started = court.launches[0]!;
  assert.equal(JSON.stringify(started.argv).includes(STAND_IN_KEY), false);
  assert.equal(JSON.stringify(court.spawnSpecs).includes(STAND_IN_KEY), false);
  assert.equal(JSON.stringify(started.env).includes(STAND_IN_KEY), false);
  const keyFile = started.env?.[PI_KEY_FILE_VARIABLE];
  assert.ok(keyFile !== undefined);
  assert.equal((await readFile(keyFile, "utf8")).trim(), STAND_IN_KEY);
});

test("P3.5 a pi launch with no DeepSeek account is refused naming it, and nothing is written or launched", async () => {
  const court = await piCourt("p35", false);
  const request = await piShadow(court.deps, "pi/flash");
  assert.equal(await runResidentAgent(request, court.deps), 1);
  assert.equal(court.launches.length, 0);
  assert.equal(court.spawnSpecs.length, 0);
  assert.ok(court.output.some((line) => /no deepseek provider account/.test(line)));
});

test("a pi launch writes the user's pi settings from the config folder into the agent's settings", async () => {
  const court = await piCourt("user-settings");
  await writeFile(court.places.settingsOverridesPath, JSON.stringify({ defaultThinkingLevel: "low" }));
  const request = await piShadow(court.deps, "pi/flash");
  await assert.rejects(runResidentAgent(request, court.deps), new RegExp(LAUNCH_STOPPED));
  const agentFolder = path.join(court.places.dataDirectory, request.name, "pi-agent");
  const settings = JSON.parse(await readFile(path.join(agentFolder, "settings.json"), "utf8"));
  assert.equal(settings.defaultThinkingLevel, "low");
  assert.equal(settings.quietStartup, true);
  assert.equal(settings.skills.length, 1);
  assert.match(settings.skills[0], /\.claude\/skills$/);
});

test("a broken pi settings file refuses the launch and names the file", async () => {
  const court = await piCourt("broken-settings");
  await writeFile(court.places.settingsOverridesPath, "{ not json");
  const request = await piShadow(court.deps, "pi/flash");
  await runResidentAgent(request, court.deps).catch(() => {});
  assert.equal(court.launches.length, 0);
  assert.match(court.output.join(""), /pi-settings\.json is not valid JSON/);
});

test("a pi launch places throne's instruction file in the agent's pi folder", async () => {
  const court = await launch("instruction-file", "pi/flash");
  const placed = path.join(court.places.dataDirectory, SHADOW_NAME, "pi-agent", "AGENTS.md");
  assert.equal((await lstat(placed)).isSymbolicLink(), true);
  assert.match(await readlink(placed), /extensions\/pi\/AGENTS\.md$/);
  assert.match(await readFile(placed, "utf8"), /web-search-<name>/);
});

test("a pi launch whose instruction file cannot be placed is refused and launches nothing", async () => {
  const court = await piCourt("instruction-file-blocked");
  const agentFolder = path.join(court.places.dataDirectory, SHADOW_NAME, "pi-agent");
  await mkdir(path.join(agentFolder, "AGENTS.md"), { recursive: true });
  const request = await piShadow(court.deps, "pi/flash");
  await runResidentAgent(request, court.deps).catch(() => {});
  assert.equal(court.launches.length, 0);
  assert.match(court.output.join(""), /pi instruction file was not placed/);
});
