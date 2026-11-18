import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { loadUserConfigFile, readFeatureSwitch } from "../user-config-loader.ts";
import { scratchUserConfig } from "../user-config-loader.test-support.ts";
import { renderFeatureLines, renderLeftoverFeaturesFileLine } from "./check-config.ts";

function scratchConfig(t: TestContext, configSource: string | null): Promise<{ directory: string; configPath: string }> {
  return scratchUserConfig(t, "features-section-spec-", configSource);
}

async function readCapturingStderr(read: () => Promise<boolean>): Promise<{ answer: boolean; written: string[] }> {
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { answer: await read(), written };
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function assertReadsOffWithOneStderrLine(read: () => Promise<boolean>): Promise<string> {
  const { answer, written } = await readCapturingStderr(read);
  assert.equal(answer, false);
  assert.equal(written.length, 1);
  return written[0] ?? "";
}

test("a features section in config.user.ts turns file-backed message bodies on", async (t) => {
  const { configPath } = await scratchConfig(t, "export default { features: { sendAgentFileBackedPayloads: true } };\n");
  assert.equal(await readFeatureSwitch("sendAgentFileBackedPayloads", configPath), true);
});

test("file-backed message bodies stay off when config.user.ts has no features section", async (t) => {
  const { directory, configPath } = await scratchConfig(t, "export default { editor: 'vi' };\n");
  assert.equal(await readFeatureSwitch("sendAgentFileBackedPayloads", configPath), false);
  assert.equal(await readFeatureSwitch("sendAgentFileBackedPayloads", path.join(directory, "absent.ts")), false);
});

test("a features value that is not true or false refuses config.user.ts naming the key", async (t) => {
  const { configPath } = await scratchConfig(t, "export default { features: { sendAgentFileBackedPayloads: 'yes' } };\n");
  await assert.rejects(loadUserConfigFile(configPath), /features\.sendAgentFileBackedPayloads/);
});

test("a features key throne does not know refuses config.user.ts naming the key", async (t) => {
  const { configPath } = await scratchConfig(t, "export default { features: { herdrDecouple: true } };\n");
  await assert.rejects(loadUserConfigFile(configPath), /features\.herdrDecouple/);
});

test("a config.user.ts that still names the removed claudeModDelivery switch is refused naming the key", async (t) => {
  const { configPath } = await scratchConfig(t, "export default { features: { claudeModDelivery: true } };\n");
  await assert.rejects(loadUserConfigFile(configPath), /features\.claudeModDelivery/);
});

test("processes reading config.user.ts at the same moment with the same token all see its switches", async (t) => {
  const { configPath } = await scratchUserConfig(t, "features-same-token-", "export default { features: { sendAgentFileBackedPayloads: true } };\n");
  const loaderUrl = new URL("../user-config-loader.ts", import.meta.url).href;
  const reader = `const { loadUserConfigFile } = await import(${JSON.stringify(loaderUrl)});
const files = await Promise.all(Array.from({ length: 10 }, () => loadUserConfigFile(${JSON.stringify(configPath)}, "same-token")));
process.stdout.write(String(files.every((file) => file?.features.sendAgentFileBackedPayloads === true)));`;
  const runReader = promisify(execFile);
  const answers = await Promise.all(Array.from({ length: 6 }, async () => (await runReader(process.execPath, ["-e", reader])).stdout));
  assert.deepEqual(answers, Array.from({ length: 6 }, () => "true"));
});

test("changing the features section takes effect at the next message without a restart", async (t) => {
  const { directory } = await scratchConfig(t, "export default { features: { sendAgentFileBackedPayloads: true } };\n");
  const linkedDirectory = `${directory}-linked`;
  await symlink(directory, linkedDirectory);
  t.after(() => rm(linkedDirectory, { force: true }));
  const configPath = path.join(linkedDirectory, "config.user.ts");
  assert.equal(await readFeatureSwitch("sendAgentFileBackedPayloads", configPath), true);
  await writeFile(configPath, "export default { features: { sendAgentFileBackedPayloads: false } };\n");
  assert.equal(await readFeatureSwitch("sendAgentFileBackedPayloads", configPath), false);
  await writeFile(configPath, "export default {{{ unparsable\n");
  await assertReadsOffWithOneStderrLine(() => readFeatureSwitch("sendAgentFileBackedPayloads", configPath));
});

test("a config.user.ts that fails to load leaves the switches off and says why once on stderr", async (t) => {
  const { configPath } = await scratchConfig(t, "export default { features: { sendAgentFileBackedPayloads: 1 } };\n");
  const line = await assertReadsOffWithOneStderrLine(() => readFeatureSwitch("sendAgentFileBackedPayloads", configPath));
  assert.match(line, /features\.sendAgentFileBackedPayloads reads as off, config\.user\.ts could not be loaded/);
});

test("check-config shows each switch from the features section with its default", async (t) => {
  const { configPath } = await scratchConfig(t, "export default { features: { sendAgentFileBackedPayloads: true } };\n");
  const lines = await renderFeatureLines(configPath);
  assert.equal(lines, `feature sendAgentFileBackedPayloads: on (default off; set in ${configPath} features.sendAgentFileBackedPayloads)\n`);
});

test("check-config says a leftover features.json is no longer read and names the switch it still turns on", async (t) => {
  const { directory } = await scratchConfig(t, null);
  assert.equal(await renderLeftoverFeaturesFileLine(directory), "");
  await writeFile(path.join(directory, "features.json"), '{"claude-mod-delivery": true, "herdr-decouple": true, "send-agent-file-backed-payloads": true}\n');
  const line = await renderLeftoverFeaturesFileLine(directory);
  assert.equal(
    line,
    `${path.join(directory, "features.json")} is no longer read and may be deleted; it turns on send-agent-file-backed-payloads (now features.sendAgentFileBackedPayloads in config.user.ts)\n`,
  );
});
