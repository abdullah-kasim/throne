import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PI_STATE_EXTENSION_SOURCE, installPiStateExtensions } from "../src/herdr/pi-state-install.ts";

test("installing pi state puts throne's state extension and herdr's pi integration in the agent's own pi folder", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "pi-state-install-"));
  try {
    const herdr = path.join(folder, "herdr");
    await writeFile(herdr, `#!/usr/bin/env bash\necho "$*" > "$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts"\n`);
    await chmod(herdr, 0o755);
    const agentDirectory = path.join(folder, "ledger", "pi-agent");
    const installed = await installPiStateExtensions(agentDirectory, herdr);
    assert.equal(await readlink(installed.throneExtension), PI_STATE_EXTENSION_SOURCE);
    assert.equal((await readFile(installed.herdrIntegration, "utf8")).trim(), "integration install pi");
    await installPiStateExtensions(agentDirectory, herdr);
    assert.equal(await readlink(installed.throneExtension), PI_STATE_EXTENSION_SOURCE);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("installing pi state is refused with herdr's words when herdr cannot install its pi integration", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "pi-state-install-"));
  try {
    const herdr = path.join(folder, "herdr");
    await writeFile(herdr, `#!/usr/bin/env bash\necho "no pi here" >&2\nexit 1\n`);
    await chmod(herdr, 0o755);
    await assert.rejects(installPiStateExtensions(path.join(folder, "pi-agent"), herdr), /herdr's pi integration did not install [\s\S]*no pi here/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
