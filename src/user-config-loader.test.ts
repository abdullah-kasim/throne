import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import {
  DEFAULT_AGENT_SETTINGS_CONFIG,
  loadAgentSettingsConfig,
} from "./agent-settings/agent-settings-user-config.ts";
import {
  loadUserConfigFile,
  resolveUserConfigPath,
  writeHomeConfigModulePackageIfMissing,
} from "./user-config-loader.ts";

const configDirectory = await mkdtemp(path.join(os.tmpdir(), "user-config-editor-"));
await writeFile(path.join(configDirectory, "package.json"), '{"type":"module"}\n');
after(() => rm(configDirectory, { recursive: true, force: true }));

const MODULE_PACKAGE = '{"type":"module"}\n';

interface ScratchPlaces {
  readonly liveThroneRoot: string;
  readonly throneHome: string;
  readonly checkoutCopy: string;
  readonly homeCopy: string;
}

function setEnvironmentForTest(t: TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function scratchPlaces(t: TestContext): Promise<ScratchPlaces> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "user-config-places-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const liveThroneRoot = path.join(scratch, "checkout");
  const throneHome = path.join(scratch, "home");
  await mkdir(liveThroneRoot, { recursive: true });
  await mkdir(path.join(throneHome, "config"), { recursive: true });
  await writeFile(path.join(liveThroneRoot, "package.json"), MODULE_PACKAGE);
  await writeFile(path.join(throneHome, "config", "package.json"), MODULE_PACKAGE);
  setEnvironmentForTest(t, "THRONE_LIVE_ROOT", liveThroneRoot);
  setEnvironmentForTest(t, "THRONE_DATA_HOME", throneHome);
  return {
    liveThroneRoot,
    throneHome,
    checkoutCopy: path.join(liveThroneRoot, "config.user.ts"),
    homeCopy: path.join(throneHome, "config", "config.user.ts"),
  };
}

function configNamingEditor(editor: string): string {
  return `export default { editor: ${JSON.stringify(editor)} };\n`;
}

test("a config.user.ts editor that is not a string is refused naming the field", async () => {
  const configPath = path.join(configDirectory, "config.user.ts");
  await writeFile(configPath, "export default { editor: 42 };\n");
  await assert.rejects(loadUserConfigFile(configPath), (error: Error) => {
    assert.match(error.message, /`editor` must be a string/);
    assert.ok(error.message.includes(configPath));
    return true;
  });
});

test("the operator's config is loaded from the config folder in the throne home", async (t) => {
  const places = await scratchPlaces(t);
  await writeFile(places.homeCopy, configNamingEditor("home-editor"));
  assert.equal(await resolveUserConfigPath(), places.homeCopy);
  assert.equal((await loadUserConfigFile())?.editor, "home-editor");
});

test("loading the checkout copy says in one line which copy was loaded", async (t) => {
  const places = await scratchPlaces(t);
  await writeFile(places.checkoutCopy, configNamingEditor("checkout-editor"));
  await writeFile(places.homeCopy, configNamingEditor("home-editor"));
  const stderrWrite = t.mock.method(process.stderr, "write", () => true);
  await resolveUserConfigPath();
  await resolveUserConfigPath();
  assert.equal(stderrWrite.mock.callCount(), 1);
  const line = String(stderrWrite.mock.calls[0].arguments[0]);
  assert.ok(line.includes(places.checkoutCopy));
  assert.ok(line.includes(places.homeCopy));
  assert.match(line, /checkout copy/);
  assert.match(line, /ignored/);
});

test("a config.user.ts in the live checkout is loaded instead of the home copy", async (t) => {
  const places = await scratchPlaces(t);
  await writeFile(places.checkoutCopy, configNamingEditor("checkout-editor"));
  await writeFile(places.homeCopy, configNamingEditor("home-editor"));
  t.mock.method(process.stderr, "write", () => true);
  assert.equal(await resolveUserConfigPath(), places.checkoutCopy);
  assert.equal((await loadUserConfigFile())?.editor, "checkout-editor");
});

test("a leftover src/config.user.ts in the live checkout is still refused when the home copy is in force", async (t) => {
  const places = await scratchPlaces(t);
  await writeFile(places.homeCopy, configNamingEditor("home-editor"));
  const leftover = path.join(places.liveThroneRoot, "src", "config.user.ts");
  await mkdir(path.dirname(leftover), { recursive: true });
  await writeFile(leftover, "export default {};\n");
  await assert.rejects(loadUserConfigFile(), (error: Error) => {
    assert.match(error.message, /Legacy steering override/);
    assert.ok(error.message.includes(leftover));
    assert.ok(error.message.includes(places.homeCopy));
    return true;
  });
});

test("a config file outside the checkout that imports types from the throne source still loads", async (t) => {
  const places = await scratchPlaces(t);
  await writeFile(
    places.homeCopy,
    "import type { PersonaConfigOverride } from './src/application-config.service.ts';\n" +
      "import type { SteeringConfigOverride } from './src/steering-user-config.ts';\n\n" +
      "const steering: SteeringConfigOverride = { autoscaleEnabled: false };\n" +
      "const persona: PersonaConfigOverride = { addressTitle: 'Captain' };\n\n" +
      "export default { ...persona, steering };\n",
  );
  const loaded = await loadUserConfigFile();
  assert.equal(loaded?.persona.addressTitle, "Captain");
  assert.equal(loaded?.steering.autoscaleEnabled, false);
});

test("with no config anywhere the committed defaults apply", async (t) => {
  await scratchPlaces(t);
  assert.equal(await loadUserConfigFile(), undefined);
  assert.deepEqual(await loadAgentSettingsConfig(), DEFAULT_AGENT_SETTINGS_CONFIG);
});

test("creating the home config folder marks it as a module folder so the home copy imports cleanly", async (t) => {
  const places = await scratchPlaces(t);
  const modulePackage = path.join(places.throneHome, "config", "package.json");
  await rm(path.join(places.throneHome, "config"), { recursive: true, force: true });
  await writeHomeConfigModulePackageIfMissing();
  assert.deepEqual(JSON.parse(await readFile(modulePackage, "utf8")), { type: "module" });
  await writeFile(modulePackage, '{"type":"module","kept":true}\n');
  await writeHomeConfigModulePackageIfMissing();
  assert.equal(JSON.parse(await readFile(modulePackage, "utf8")).kept, true);
  await writeFile(places.homeCopy, configNamingEditor("home-editor"));
  assert.equal((await loadUserConfigFile())?.editor, "home-editor");
});
