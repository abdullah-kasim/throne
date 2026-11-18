import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  PI_DEFAULT_SETTINGS,
  piModelToResume,
  readPiSettingsOverrides,
  resolvePiModel,
  writePiAgentDirectory,
} from "../src/pi-models/pi-models.ts";
import { startPiProviderStandIn } from "./support/pi-provider-stand-in/pi-provider-stand-in.mjs";

const scratchFolders: string[] = [];
const closers: Array<() => Promise<void>> = [];

after(async () => {
  for (const close of closers) await close();
  for (const folder of scratchFolders) await rm(folder, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "pi-models-"));
  scratchFolders.push(folder);
  return folder;
}

async function standIn(models: Array<{ id: string }>) {
  const server = await startPiProviderStandIn({ models: models.map((model) => ({ ...model, object: "model", owned_by: "deepseek" })) });
  closers.push(() => server.close());
  return server;
}

const VERSIONED_LIST = [{ id: "deepseek-v4-flash" }, { id: "deepseek-v5-flash" }, { id: "deepseek-v4-pro" }];

test("flash and pro resolve to the newest model of their family the provider lists", async () => {
  const server = await standIn(VERSIONED_LIST);
  const cacheDirectory = await scratch();
  const flash = await resolvePiModel({ family: "flash", key: "k", cacheDirectory, baseUrl: server.baseUrl });
  const pro = await resolvePiModel({ family: "pro", key: "k", cacheDirectory, baseUrl: server.baseUrl });
  assert.equal(flash.id, "deepseek-v5-flash");
  assert.equal(flash.source, "listed");
  assert.equal(pro.id, "deepseek-v4-pro");
});

test("a moving family name the provider lists beats every versioned id", async () => {
  const server = await standIn([{ id: "deepseek-v9-flash" }, { id: "deepseek-flash" }]);
  const resolved = await resolvePiModel({ family: "flash", key: "k", cacheDirectory: await scratch(), baseUrl: server.baseUrl });
  assert.equal(resolved.id, "deepseek-flash");
});

test("an unreachable list with an earlier answer cached uses the cached version and says so", async () => {
  const server = await standIn(VERSIONED_LIST);
  const cacheDirectory = await scratch();
  const dayAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await resolvePiModel({ family: "flash", key: "k", cacheDirectory, baseUrl: server.baseUrl, now: dayAgo });
  server.setModelListAvailable(false);
  const resolved = await resolvePiModel({ family: "flash", key: "k", cacheDirectory, baseUrl: server.baseUrl });
  assert.equal(resolved.id, "deepseek-v5-flash");
  assert.equal(resolved.source, "cached");
  assert.match(resolved.note, /could not be reached.*cached deepseek-v5-flash/);
});

test("an unreachable list with nothing cached uses the registry's pinned version and says so", async () => {
  const server = await standIn(VERSIONED_LIST);
  server.setModelListAvailable(false);
  const resolved = await resolvePiModel({ family: "pro", key: "k", cacheDirectory: await scratch(), baseUrl: server.baseUrl });
  assert.equal(resolved.id, "deepseek-v4-pro");
  assert.equal(resolved.source, "pinned");
  assert.match(resolved.note, /could not be reached.* and nothing is cached; using the registry's pinned deepseek-v4-pro/);
});

test("the model list is cached for a day so a changed list is not seen until then", async () => {
  const server = await standIn(VERSIONED_LIST);
  const cacheDirectory = await scratch();
  await resolvePiModel({ family: "flash", key: "k", cacheDirectory, baseUrl: server.baseUrl });
  server.setModels([{ id: "deepseek-v6-flash", object: "model", owned_by: "deepseek" }]);
  const sameDay = await resolvePiModel({ family: "flash", key: "k", cacheDirectory, baseUrl: server.baseUrl });
  const nextDay = await resolvePiModel({ family: "flash", key: "k", cacheDirectory, baseUrl: server.baseUrl, now: new Date(Date.now() + 25 * 60 * 60 * 1000) });
  assert.equal(sameDay.id, "deepseek-v5-flash");
  assert.equal(nextDay.id, "deepseek-v6-flash");
});

test("an agent launched on deepseek-v4-flash resumes on it after the list gains deepseek-v5-flash", async () => {
  const server = await standIn([{ id: "deepseek-v4-flash" }]);
  const cacheDirectory = await scratch();
  const launched = await resolvePiModel({ family: "flash", key: "k", cacheDirectory, baseUrl: server.baseUrl });
  server.setModels(VERSIONED_LIST.map((model) => ({ ...model, object: "model", owned_by: "deepseek" })));
  assert.equal(piModelToResume({ pi_model_id: launched.id }), "deepseek-v4-flash");
});

test("the pi agent folder names deepseek and the chosen model and never holds the key", async () => {
  const agentDirectory = path.join(await scratch(), "pi-agent");
  const { modelsPath, settingsPath } = await writePiAgentDirectory({ agentDirectory, modelId: "deepseek-v5-flash", baseUrl: "http://127.0.0.1:1" });
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(models, { providers: { deepseek: { baseUrl: "http://127.0.0.1:1", models: [{ id: "deepseek-v5-flash" }] } } });
  assert.deepEqual(settings, { ...PI_DEFAULT_SETTINGS, defaultProvider: "deepseek", defaultModel: "deepseek-v5-flash" });
  assert.doesNotMatch(await readFile(modelsPath, "utf8"), /apiKey|key/i);
});

test("a built-in model with no base url writes no provider entry, which pi refuses when empty", async () => {
  const agentDirectory = path.join(await scratch(), "pi-agent");
  const { modelsPath } = await writePiAgentDirectory({ agentDirectory, modelId: "deepseek-flash" });
  assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")), { providers: {} });
});

async function settingsWrittenWith(request: { settingsOverrides?: Record<string, unknown>; alreadyThere?: Record<string, unknown> }) {
  const agentDirectory = path.join(await scratch(), "pi-agent");
  if (request.alreadyThere !== undefined) {
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(path.join(agentDirectory, "settings.json"), JSON.stringify(request.alreadyThere));
  }
  const { settingsPath } = await writePiAgentDirectory({
    agentDirectory,
    modelId: "deepseek-v5-flash",
    ...(request.settingsOverrides === undefined ? {} : { settingsOverrides: request.settingsOverrides }),
  });
  return JSON.parse(await readFile(settingsPath, "utf8"));
}

test("a pi agent starts quiet: thinking blocks, the start-up listing and long changelogs are hidden by default", async () => {
  const settings = await settingsWrittenWith({});
  assert.equal(settings.hideThinkingBlock, true);
  assert.equal(settings.quietStartup, true);
  assert.equal(settings.collapseChangelog, true);
});

test("the user's pi settings are laid over throne's defaults and may add any other pi setting", async () => {
  const settings = await settingsWrittenWith({ settingsOverrides: { hideThinkingBlock: false, defaultThinkingLevel: "low" } });
  assert.equal(settings.hideThinkingBlock, false);
  assert.equal(settings.defaultThinkingLevel, "low");
  assert.equal(settings.quietStartup, true);
});

test("the user's pi settings cannot change the provider or the model throne chose", async () => {
  const settings = await settingsWrittenWith({ settingsOverrides: { defaultProvider: "elsewhere", defaultModel: "another-model" } });
  assert.equal(settings.defaultProvider, "deepseek");
  assert.equal(settings.defaultModel, "deepseek-v5-flash");
});

test("a relaunch keeps the changelog version pi recorded and nothing else from the old file", async () => {
  const settings = await settingsWrittenWith({ alreadyThere: { lastChangelogVersion: "1.5.2", hideThinkingBlock: false, leftover: 1 } });
  assert.equal(settings.lastChangelogVersion, "1.5.2");
  assert.equal(settings.hideThinkingBlock, true);
  assert.equal(settings.leftover, undefined);
});

test("no pi settings file means no overrides", async () => {
  assert.deepEqual(await readPiSettingsOverrides(path.join(await scratch(), "pi-settings.json")), {});
});

test("a pi settings file that is not one JSON object is refused by name", async () => {
  const folder = await scratch();
  const broken = path.join(folder, "broken.json");
  const list = path.join(folder, "list.json");
  await writeFile(broken, "{ not json");
  await writeFile(list, "[1, 2]");
  await assert.rejects(readPiSettingsOverrides(broken), new RegExp(`${broken} is not valid JSON`));
  await assert.rejects(readPiSettingsOverrides(list), new RegExp(`${list} must hold one JSON object`));
});

test("a pi agent is given throne's skills folder whatever folder it works in, and trusts no project by default", async () => {
  const agentDirectory = path.join(await scratch(), "pi-agent");
  const { settingsPath } = await writePiAgentDirectory({ agentDirectory, modelId: "deepseek-v5-flash", throneSkillsDirectory: "/throne/.claude/skills" });
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(settings.skills, ["/throne/.claude/skills"]);
  assert.equal(settings.defaultProjectTrust, undefined);
});

test("skill folders in the user's pi settings are added after throne's, never in place of it", async () => {
  const agentDirectory = path.join(await scratch(), "pi-agent");
  const { settingsPath } = await writePiAgentDirectory({
    agentDirectory,
    modelId: "deepseek-v5-flash",
    throneSkillsDirectory: "/throne/.claude/skills",
    settingsOverrides: { skills: ["/my/skills"] },
  });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).skills, ["/throne/.claude/skills", "/my/skills"]);
});
