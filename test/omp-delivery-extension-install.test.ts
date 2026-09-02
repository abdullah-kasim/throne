// The throne installs its omp delivery extension by SYMLINK into omp's own
// extension directory, and detects omp by that directory rather than by an
// `omp` binary on PATH — the binary lives at ~/.bun/bin/omp on this host and
// a systemd user unit's PATH would not find it, which would turn "install the
// extension" into a silent no-op.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installOmpDeliveryExtension,
  ompAgentDirectory,
  INSTALLED_EXTENSION_NAME,
} from "../src/herdr/omp-extension-install.ts";

const SOURCE = "/checkout/extensions/omp/throne-omp-delivery.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omp-install-"));
}

test("a host with no omp agent directory installs nothing and says so", async () => {
  const dir = await scratch();
  try {
    const outcome = await installOmpDeliveryExtension({
      agentDir: join(dir, "never-created"),
      source: SOURCE,
      findExecutable: async () => undefined,
    });
    assert.equal(outcome.kind, "omp-absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an omp host gets a symlink back into the checkout", async () => {
  const dir = await scratch();
  try {
    await mkdir(join(dir, "agent"), { recursive: true });
    const outcome = await installOmpDeliveryExtension({
      agentDir: join(dir, "agent"),
      source: SOURCE,
    });
    assert.equal(outcome.kind, "installed");
    // A symlink, not a copy: a copy goes stale the moment the checkout moves,
    // and a stale delivery protocol is the defect this feature removes.
    assert.equal(
      await readlink(join(dir, "agent", "extensions", INSTALLED_EXTENSION_NAME)),
      SOURCE,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installing twice is a no-op that reports already-current", async () => {
  const dir = await scratch();
  try {
    await mkdir(join(dir, "agent"), { recursive: true });
    await installOmpDeliveryExtension({ agentDir: join(dir, "agent"), source: SOURCE });
    const again = await installOmpDeliveryExtension({
      agentDir: join(dir, "agent"),
      source: SOURCE,
    });
    assert.equal(again.kind, "already-current");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a symlink pointing at an OLD checkout is repointed, and says what it replaced", async () => {
  const dir = await scratch();
  try {
    const extensions = join(dir, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await symlink("/old/checkout/throne-omp-delivery.ts", join(extensions, INSTALLED_EXTENSION_NAME));
    const outcome = await installOmpDeliveryExtension({
      agentDir: join(dir, "agent"),
      source: SOURCE,
    });
    assert.equal(outcome.kind, "installed");
    assert.equal(outcome.replaced, "/old/checkout/throne-omp-delivery.ts");
    assert.equal(await readlink(join(extensions, INSTALLED_EXTENSION_NAME)), SOURCE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a REAL file at that path blocks the install instead of being deleted", async () => {
  // Somebody may have hand-written an extension under that name. Deleting a
  // person's code to install our own is not a repair.
  const dir = await scratch();
  try {
    const extensions = join(dir, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(join(extensions, INSTALLED_EXTENSION_NAME), "// hand written\n");
    const outcome = await installOmpDeliveryExtension({
      agentDir: join(dir, "agent"),
      source: SOURCE,
    });
    assert.equal(outcome.kind, "blocked");
    assert.match(outcome.reason, /refusing to delete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the agent directory is overridable, and defaults under the home directory", () => {
  assert.equal(
    ompAgentDirectory({ OMP_AGENT_DIR: "/somewhere/else" }, "/home/x"),
    "/somewhere/else",
  );
  assert.equal(ompAgentDirectory({}, "/home/x"), "/home/x/.omp/agent");
});

// --- Belt and suspenders: the executable probe backs up the directory probe ---

import { chmod } from "node:fs/promises";
import { findOmpExecutable } from "../src/herdr/omp-extension-install.ts";

test("an omp binary with NO agent directory still installs, creating the directory", async () => {
  // omp installed but never run: nothing has created its config yet. Waiting
  // for a second startup to notice would leave the first omp session without
  // delivery for no reason.
  const dir = await scratch();
  try {
    const agentDir = join(dir, "agent");
    const outcome = await installOmpDeliveryExtension({
      agentDir,
      source: SOURCE,
      findExecutable: async () => "/home/x/.bun/bin/omp",
    });
    assert.equal(outcome.kind, "installed-ahead-of-first-run");
    assert.equal(outcome.executable, "/home/x/.bun/bin/omp");
    assert.equal(
      await readlink(join(agentDir, "extensions", INSTALLED_EXTENSION_NAME)),
      SOURCE,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no directory and no binary means omp is genuinely absent", async () => {
  const dir = await scratch();
  try {
    const outcome = await installOmpDeliveryExtension({
      agentDir: join(dir, "agent"),
      source: SOURCE,
      findExecutable: async () => undefined,
    });
    assert.equal(outcome.kind, "omp-absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the executable probe finds omp on PATH", async () => {
  const dir = await scratch();
  try {
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    const binary = join(binDir, "omp");
    await writeFile(binary, "#!/bin/sh\n");
    await chmod(binary, 0o755);
    assert.equal(await findOmpExecutable({ PATH: binDir }, dir), binary);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the executable probe finds omp under ~/.bun/bin when PATH is thin", async () => {
  // The real shape on this host: omp lives at ~/.bun/bin/omp, and a systemd
  // user unit's PATH does not include it. A PATH-only probe would report
  // "omp absent" on a machine that plainly has omp — a silent no-op.
  const dir = await scratch();
  try {
    const bunBin = join(dir, ".bun", "bin");
    await mkdir(bunBin, { recursive: true });
    const binary = join(bunBin, "omp");
    await writeFile(binary, "#!/bin/sh\n");
    await chmod(binary, 0o755);
    assert.equal(await findOmpExecutable({ PATH: "/usr/bin:/bin" }, dir), binary);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-executable file named omp is not mistaken for the binary", async () => {
  const dir = await scratch();
  try {
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "omp"), "not executable\n");
    await chmod(join(binDir, "omp"), 0o644);
    assert.equal(await findOmpExecutable({ PATH: binDir }, dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
