import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSpawnSpec, writeSpawnSpec, type SpawnSpec } from "./spawn-data-contracts.ts";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function dataFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "spawn-spec-"));
  folders.push(folder);
  return folder;
}

const baseSpec: SpawnSpec = { harness: "claude", model: "opus", effort: 1, cwd: "/work", claude_mod: true };

test("a spawn record keeps the delivery socket it was written with", async () => {
  const folder = await dataFolder();
  await writeSpawnSpec("agent", { ...baseSpec, delivery_socket: "/home/x/.throne/s/ab12.sock" }, folder);
  assert.equal((await readSpawnSpec("agent", folder))?.delivery_socket, "/home/x/.throne/s/ab12.sock");
});

test("a spawn record with an empty or non-string delivery socket is not read as a spawn record", async () => {
  const folder = await dataFolder();
  for (const [name, socket] of [["empty", ""], ["number", 7]] as const) {
    await mkdir(path.join(folder, name), { recursive: true });
    await writeFile(path.join(folder, name, "spawn.json"), JSON.stringify({ ...baseSpec, delivery_socket: socket }));
    assert.equal(await readSpawnSpec(name, folder), null);
  }
});
