import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { renderPiSettingsLine } from "../check-config/check-config.ts";
import { PI_DEFAULT_SETTINGS, writePiAgentDirectory } from "../pi-models/pi-models.ts";
import { loadUserConfigFile } from "../user-config-loader.ts";
import { scratchUserConfig } from "../user-config-loader.test-support.ts";
import { piSettingsOverrides, readOperatorPiSettings, realPiLaunchPlaces } from "./pi-launch.ts";

interface Scratch {
  readonly directory: string;
  readonly configPath: string;
  readonly settingsFilePath: string;
}

async function scratch(t: TestContext, configSource: string | null): Promise<Scratch> {
  const { directory, configPath } = await scratchUserConfig(t, "pi-settings-spec-", configSource);
  return { directory, configPath, settingsFilePath: path.join(directory, "pi-settings.json") };
}

async function writtenSettings(place: Scratch): Promise<Record<string, unknown>> {
  const settingsOverrides = await piSettingsOverrides({
    ...realPiLaunchPlaces(),
    settingsOverridesPath: place.settingsFilePath,
    readOperatorPiSettings: () => readOperatorPiSettings(place.configPath),
  });
  const { settingsPath } = await writePiAgentDirectory({
    agentDirectory: path.join(place.directory, "pi-agent"),
    modelId: "deepseek-chat",
    settingsOverrides,
  });
  return JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
}

test("piSettings from config.user.ts are laid over a pi agent's default settings", async (t) => {
  const place = await scratch(t, `export default { piSettings: { defaultTools: ["+codemode"] } };\n`);
  const settings = await writtenSettings(place);
  assert.deepEqual(settings.defaultTools, ["+codemode"]);
  for (const key of Object.keys(PI_DEFAULT_SETTINGS)) assert.ok(key in settings, key);
  assert.equal(settings.defaultModel, "deepseek-chat");
});

test("config.user.ts wins over pi-settings.json for the same pi setting", async (t) => {
  const place = await scratch(t, `export default { piSettings: { theme: "light" } };\n`);
  await writeFile(place.settingsFilePath, JSON.stringify({ theme: "dark", quietStartup: true }));
  const settings = await writtenSettings(place);
  assert.equal(settings.theme, "light");
  assert.equal(settings.quietStartup, true);
});

for (const ownedKey of ["defaultProvider", "defaultModel"]) {
  test(`a piSettings that names ${ownedKey} is refused`, async (t) => {
    const place = await scratch(t, `export default { piSettings: { ${ownedKey}: "other" } };\n`);
    await assert.rejects(loadUserConfigFile(place.configPath), new RegExp(`piSettings\\.${ownedKey}`));
  });
}

test("a piSettings that is not an object is refused", async (t) => {
  const place = await scratch(t, `export default { piSettings: ["+codemode"] };\n`);
  await assert.rejects(loadUserConfigFile(place.configPath), /`piSettings` must be a plain object/);
});

test("a piSettings value that is not JSON is refused", async (t) => {
  const place = await scratch(t, `export default { piSettings: { hook: () => 1 } };\n`);
  await assert.rejects(loadUserConfigFile(place.configPath), /`piSettings\.hook` must be a JSON value/);
});

test("a config.user.ts without piSettings leaves a pi agent's settings unchanged", async (t) => {
  const withoutSection = await scratch(t, `export default { editor: "vim" };\n`);
  const withoutFile = await scratch(t, null);
  assert.deepEqual(await writtenSettings(withoutSection), await writtenSettings(withoutFile));
});

test("a config.user.ts that fails to load does not stop a pi launch", async (t) => {
  const place = await scratch(t, `export default { unknownSection: true };\n`);
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = originalWrite;
  });
  const settings = await writtenSettings(place);
  process.stderr.write = originalWrite;
  assert.equal(settings.defaultModel, "deepseek-chat");
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /piSettings not applied/);
});

test("check-config names the piSettings keys", async (t) => {
  const place = await scratch(t, `export default { piSettings: { defaultTools: ["+codemode"], theme: "secret-value" } };\n`);
  assert.equal(await renderPiSettingsLine(place.configPath), "piSettings: defaultTools, theme\n");
  const empty = await scratch(t, `export default {};\n`);
  assert.equal(await renderPiSettingsLine(empty.configPath), "piSettings: none\n");
});

test("a pi agent throne launches has code mode in its default tools", async (t) => {
  const place = await scratch(t, null);
  const settingsOverrides = await piSettingsOverrides({
    ...realPiLaunchPlaces(),
    settingsOverridesPath: place.settingsFilePath,
    readOperatorPiSettings: () => readOperatorPiSettings(place.configPath),
  });
  assert.deepEqual(settingsOverrides, { defaultTools: ["+codemode"] });
  assert.deepEqual((await writtenSettings(place)).defaultTools, ["+codemode"]);
});

test("the operator's pi defaultTools replaces throne's code mode default", async (t) => {
  const place = await scratch(t, `export default { piSettings: { defaultTools: ["read", "bash"] } };\n`);
  assert.deepEqual((await writtenSettings(place)).defaultTools, ["read", "bash"]);
});
