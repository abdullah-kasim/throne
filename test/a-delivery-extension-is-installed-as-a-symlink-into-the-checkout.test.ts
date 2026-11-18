import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDeliveryExtension } from "../src/herdr/extension-install.ts";

const SOURCE = "/checkout/extensions/pi/throne-pi-delivery.ts";
const LINK_NAME = "throne-pi-delivery.ts";

async function withScratch(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "extension-install-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function install(agentDir: string, findExecutable: () => Promise<string | undefined> = async () => undefined) {
  return installDeliveryExtension({ agentDir, source: SOURCE, linkName: LINK_NAME, findExecutable });
}

test("an agent directory with no harness binary installs nothing and says so", () =>
  withScratch(async (directory) => {
    const outcome = await install(join(directory, "never-created"));
    assert.equal(outcome.kind, "harness-absent");
  }));

test("an existing agent directory gets a symlink back into the checkout", () =>
  withScratch(async (directory) => {
    await mkdir(join(directory, "agent"), { recursive: true });
    const outcome = await install(join(directory, "agent"));
    assert.equal(outcome.kind, "installed");
    assert.equal(await readlink(join(directory, "agent", "extensions", LINK_NAME)), SOURCE);
  }));

test("a harness binary with no agent directory still installs, creating the directory", () =>
  withScratch(async (directory) => {
    const agentDir = join(directory, "agent");
    const outcome = await install(agentDir, async () => "piy");
    assert.equal(outcome.kind, "installed-ahead-of-first-run");
    assert.equal(await readlink(join(agentDir, "extensions", LINK_NAME)), SOURCE);
  }));

test("installing twice is a no-op that reports already-current", () =>
  withScratch(async (directory) => {
    await mkdir(join(directory, "agent"), { recursive: true });
    await install(join(directory, "agent"));
    const again = await install(join(directory, "agent"));
    assert.equal(again.kind, "already-current");
  }));

test("a symlink pointing at an old checkout is repointed, and says what it replaced", () =>
  withScratch(async (directory) => {
    const extensions = join(directory, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await symlink("/old/checkout/throne-pi-delivery.ts", join(extensions, LINK_NAME));
    const outcome = await install(join(directory, "agent"));
    assert.equal(outcome.kind, "installed");
    assert.equal(outcome.kind === "installed" ? outcome.replaced : undefined, "/old/checkout/throne-pi-delivery.ts");
    assert.equal(await readlink(join(extensions, LINK_NAME)), SOURCE);
  }));

test("a real file at the link path blocks the install instead of being deleted", () =>
  withScratch(async (directory) => {
    const extensions = join(directory, "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(join(extensions, LINK_NAME), "hand written\n");
    const outcome = await install(join(directory, "agent"));
    assert.equal(outcome.kind, "blocked");
    assert.match(outcome.kind === "blocked" ? outcome.reason : "", /refusing to delete/);
  }));
