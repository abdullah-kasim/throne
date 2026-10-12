import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadUserConfigFile } from "./user-config-loader.ts";

const configDirectory = await mkdtemp(path.join(os.tmpdir(), "user-config-editor-"));
await writeFile(path.join(configDirectory, "package.json"), '{"type":"module"}\n');
after(() => rm(configDirectory, { recursive: true, force: true }));

test("a config.user.ts editor that is not a string is refused naming the field", async () => {
  const configPath = path.join(configDirectory, "config.user.ts");
  await writeFile(configPath, "export default { editor: 42 };\n");
  await assert.rejects(loadUserConfigFile(configPath), (error: Error) => {
    assert.match(error.message, /`editor` must be a string/);
    assert.ok(error.message.includes(configPath));
    return true;
  });
});
