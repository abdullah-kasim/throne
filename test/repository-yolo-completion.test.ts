import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repositoryIsYolo, YOLO_KEY } from "../src/forge/repository-yolo.ts";
import { checkTerminalDeliveryPrecondition } from "../src/slice-evidence/agent-evidence-gate.ts";
import { git, initRepo } from "../src/slice-evidence/agent-evidence-gate.test-support.ts";

const YOLO_ALPHA = "alpha-yolofix-01";
const YOLO_DELIVERY = "shadow-yolofix-99c-deliver-yolofix";
const PLAIN_ALPHA = "alpha-plainfix-01";
const PLAIN_DELIVERY = "shadow-plainfix-99c-deliver-plainfix";

let root: string;
let dataDir: string;
let yoloRepo: string;
let plainRepo: string;
let unreadableRepo: string;

const BUNDLE = "todo-2026-10-30-0000-fixture";
const DELIVERY_RECORD = "99c_deliver_fixture.md";

async function writeDeliveryRecord(alpha: string, outcomeLine: string): Promise<void> {
  const bundle = path.join(dataDir, alpha, BUNDLE);
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, DELIVERY_RECORD), `# Deliver\n\n${outcomeLine}\n`, "utf8");
}

async function writeLedger(name: string, files: Record<string, string>): Promise<void> {
  const directory = path.join(dataDir, name);
  await mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(directory, file), content, "utf8");
  }
}

async function buildCampaign(label: string, alpha: string, delivery: string, originUrl: string): Promise<string> {
  const repo = path.join(root, `${label}-clone`);
  await mkdir(repo);
  await initRepo(repo);
  await git(repo, ["remote", "add", "origin", originUrl]);
  const base = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["update-ref", "refs/remotes/origin/main", base]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(repo, ["switch", "-c", alpha]);
  await writeFile(path.join(repo, "feature.txt"), "feature\n", "utf8");
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", "feature"]);
  await git(repo, ["switch", "main"]);
  await git(repo, ["merge", "--ff-only", alpha]);
  await writeLedger(alpha, {
    "identity.md": "- **Role:** Alpha\n- **Supervisor (routine):** Regent\n",
    "spawn.json": JSON.stringify({ harness: "claude", model: "opus", effort: 3, cwd: repo, objective_code: label }),
    "tree-base.json": JSON.stringify({ name: alpha, branch: "main", commit: base, repo }),
  });
  await writeLedger(delivery, {
    "identity.md": `- **Role:** Shadow\n- **Supervisor (routine):** ${alpha}\n`,
    "spawn.json": JSON.stringify({ harness: "claude", model: "opus", effort: 3, cwd: repo }),
  });
  return repo;
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "repository-yolo-completion-"));
  dataDir = path.join(root, "data");
  const origin = path.join(root, "origin.git");
  await git(root, ["init", "--bare", "-b", "main", origin]);
  yoloRepo = await buildCampaign("yolofix", YOLO_ALPHA, YOLO_DELIVERY, origin);
  await git(yoloRepo, ["push", "origin", "refs/remotes/origin/main:refs/heads/main"]);
  await git(yoloRepo, ["config", YOLO_KEY, "true"]);
  plainRepo = await buildCampaign("plainfix", PLAIN_ALPHA, PLAIN_DELIVERY, path.join(root, "no-such-origin.git"));
  unreadableRepo = path.join(root, "unreadable");
  await mkdir(unreadableRepo);
  await initRepo(unreadableRepo);
  await git(unreadableRepo, ["config", YOLO_KEY, "maybe"]);
  await writeDeliveryRecord(PLAIN_ALPHA, "**Delivery outcome:** PASS");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a repository that sets throne.yolo to true is a yolo repository", async () => {
  assert.equal(await repositoryIsYolo(yoloRepo), true);
});

test("a repository without throne.yolo is not a yolo repository", async () => {
  assert.equal(await repositoryIsYolo(plainRepo), false);
});

test("a throne.yolo value git cannot read as true or false is refused naming the key", async () => {
  await assert.rejects(repositoryIsYolo(unreadableRepo), (error: Error) => error.message.includes(YOLO_KEY));
});

test("in a yolo repository the delivery step cannot complete while the campaign is only on the local default branch", async () => {
  const result = await checkTerminalDeliveryPrecondition(YOLO_DELIVERY, dataDir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "delivery-not-proven");
  assert.match(result.detail ?? "", /is not on origin\/main/);
  assert.match(result.detail ?? "", /git push origin main/);
});

test("in a yolo repository a campaign Alpha cannot complete while its work is not on origin's default branch", async () => {
  const result = await checkTerminalDeliveryPrecondition(YOLO_ALPHA, dataDir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "delivery-not-proven");
  assert.match(result.detail ?? "", new RegExp(yoloRepo));
});

test("in a yolo repository the delivery step completes once the campaign is on origin's default branch", async () => {
  await git(yoloRepo, ["push", "origin", "main"]);
  await writeDeliveryRecord(YOLO_ALPHA, `**Delivery outcome:** PASS at ${await git(yoloRepo, ["rev-parse", "origin/main"])}`);
  assert.equal((await checkTerminalDeliveryPrecondition(YOLO_DELIVERY, dataDir)).ok, true);
  assert.equal((await checkTerminalDeliveryPrecondition(YOLO_ALPHA, dataDir)).ok, true);
});

test("in a yolo repository a delivery record that says PASS without naming the origin commit is refused", async () => {
  await writeDeliveryRecord(YOLO_ALPHA, "**Delivery outcome:** PASS");
  const result = await checkTerminalDeliveryPrecondition(YOLO_DELIVERY, dataDir);
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /does not hold "\*\*Delivery outcome:\*\* PASS at <full sha>"/);
});

test("in a yolo repository a delivery record naming a commit that does not contain the campaign is refused", async () => {
  const base = await git(yoloRepo, ["rev-parse", `${YOLO_ALPHA}~1`]);
  await writeDeliveryRecord(YOLO_ALPHA, `**Delivery outcome:** PASS at ${base}`);
  const result = await checkTerminalDeliveryPrecondition(YOLO_ALPHA, dataDir);
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", new RegExp(`names ${base}, which does not contain campaign head`));
});

test("in a yolo repository a delivery record naming the pushed origin commit lets the campaign complete", async () => {
  await writeDeliveryRecord(YOLO_ALPHA, `**Delivery outcome:** PASS at ${await git(yoloRepo, ["rev-parse", "origin/main"])}`);
  assert.equal((await checkTerminalDeliveryPrecondition(YOLO_DELIVERY, dataDir)).ok, true);
  assert.equal((await checkTerminalDeliveryPrecondition(YOLO_ALPHA, dataDir)).ok, true);
});

test("in a yolo repository an empty completion stamp after the push is accepted", async () => {
  const stamp = await git(yoloRepo, ["commit-tree", `${YOLO_ALPHA}^{tree}`, "-p", YOLO_ALPHA, "-m", "stamp"]);
  await git(yoloRepo, ["update-ref", `refs/heads/${YOLO_ALPHA}`, stamp]);
  assert.equal((await checkTerminalDeliveryPrecondition(YOLO_DELIVERY, dataDir)).ok, true);
  assert.equal((await checkTerminalDeliveryPrecondition(YOLO_ALPHA, dataDir)).ok, true);
});

test("in a yolo repository a file change after the push is refused", async () => {
  await git(yoloRepo, ["switch", YOLO_ALPHA]);
  await writeFile(path.join(yoloRepo, "late.txt"), "late\n", "utf8");
  await git(yoloRepo, ["add", "late.txt"]);
  await git(yoloRepo, ["commit", "--no-gpg-sign", "-m", "late"]);
  await git(yoloRepo, ["switch", "main"]);
  const result = await checkTerminalDeliveryPrecondition(YOLO_ALPHA, dataDir);
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /is not on origin\/main/);
});

test("outside a yolo repository a campaign completes without its work being pushed, as before", async () => {
  assert.equal((await checkTerminalDeliveryPrecondition(PLAIN_DELIVERY, dataDir)).ok, true);
  assert.equal((await checkTerminalDeliveryPrecondition(PLAIN_ALPHA, dataDir)).ok, true);
});

test("outside a yolo repository the delivery record is not read", async () => {
  const result = await checkTerminalDeliveryPrecondition(PLAIN_ALPHA, dataDir);
  assert.deepEqual(result, { ok: true });
});
