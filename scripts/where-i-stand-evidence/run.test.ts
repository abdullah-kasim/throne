import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const evidenceRun = path.join(repositoryRoot, "scripts", "where-i-stand-evidence", "run.mjs");

async function occupy(port: number): Promise<Server> {
  const squatter = createServer();
  await new Promise<void>((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(port, "127.0.0.1", resolve);
  });
  return squatter;
}

async function freePortPair(): Promise<number> {
  for (;;) {
    const probe = await occupy(0);
    const port = (probe.address() as { port: number }).port;
    probe.close();
    if (port > 65_000) continue;
    const pair = await Promise.all([occupy(port).catch(() => null), occupy(port + 1).catch(() => null)]);
    for (const server of pair) server?.close();
    if (pair.every(Boolean)) return port;
  }
}

async function runWithTakenPort(takenOffset: number) {
  const basePort = await freePortPair();
  const takenPort = basePort + takenOffset;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "where-i-stand-evidence-bind-"));
  const out = path.join(scratch, "out");
  const squatter = await occupy(takenPort);
  try {
    const result = spawnSync(
      process.execPath,
      [evidenceRun, "--preset", "queue", "--viewport", "phone", "--port", String(basePort), "--out", out, "--data-home", path.join(scratch, "home"), "--reference-tree", repositoryRoot],
      { encoding: "utf8", timeout: 60_000 },
    );
    const captures = (await readdir(out, { recursive: true }).catch(() => [])).filter((name) => name.endsWith(".png") || name.endsWith(".json"));
    const ownServerStillAnswers = await fetch(`http://127.0.0.1:${takenOffset === 0 ? basePort + 1 : basePort}/api/health`).then(() => true, () => false);
    return { result, captures, ownServerStillAnswers, takenPort };
  } finally {
    squatter.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

test("the evidence run fails when the product port is already taken instead of capturing another server", async () => {
  const { result, captures, ownServerStillAnswers, takenPort } = await runWithTakenPort(0);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`port ${takenPort}`));
  assert.deepEqual(captures, []);
  assert.equal(ownServerStillAnswers, false);
});

test("the evidence run fails when the reference port is already taken instead of capturing another server", async () => {
  const { result, captures, ownServerStillAnswers, takenPort } = await runWithTakenPort(1);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`port ${takenPort}`));
  assert.deepEqual(captures, []);
  assert.equal(ownServerStillAnswers, false);
});
