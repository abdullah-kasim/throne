import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installPiStateExtensions } from "./pi-state-install.ts";

it("the hook bridge is installed beside the pi state extension", async () => {
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-"));
  const installed = await installPiStateExtensions(agentDirectory, "/bin/true");
  assert.equal(path.dirname(await readlink(installed.hooksExtension)), path.dirname(await readlink(installed.throneExtension)));
  assert.equal(path.basename(installed.hooksExtension), "throne-pi-hooks.ts");
});
