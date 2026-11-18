import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasDeliveryCommit } from "../src/git-lifecycle/delivery-commit-proof.ts";
import { DELIVERY_EVIDENCE_DATA } from "../src/agentdata/delivery-evidence-data.service.ts";
import { TREE_BASE_DATA } from "../src/agentdata/tree-base-data.service.ts";
import { run as recordDeliveryCommand } from "../src/record-delivery/record-delivery-runtime.ts";
import { checkDeliveryVerdict } from "../src/verify-delivery/verify-delivery-runtime.ts";
import { git, initRepo } from "./git-repo-test-fixture.ts";

async function commitFile(repo: string, name: string, content: string, subject: string): Promise<string> {
  await writeFile(path.join(repo, name), content, "utf8");
  await git(repo, ["add", name]);
  await git(repo, ["commit", "--no-gpg-sign", "-m", subject]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function scratch(): Promise<{ repo: string; dataDir: string; cleanup: () => Promise<void> }> {
  const repo = await initRepo("record-proof-");
  const dataDir = await mkdtemp(path.join(tmpdir(), "record-proof-data-"));
  return {
    repo,
    dataDir,
    cleanup: async () => {
      await rm(repo, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function recordCommand(args: string[]): Promise<{ code: number; text: string }> {
  let text = "";
  const collect = (message: string): void => void (text += message);
  return recordDeliveryCommand(args, { out: collect, err: collect }).then((code) => ({ code, text }));
}

test("a delivered agent with a record is proven delivered without any commit titled Deliver", async () => {
  const { repo, dataDir, cleanup } = await scratch();
  try {
    const commit = await commitFile(repo, "work.txt", "work\n", "Add the work file");
    await DELIVERY_EVIDENCE_DATA.write("worker", { repo, targetBranch: "main", commit }, dataDir);
    const root = await git(repo, ["rev-parse", "--show-toplevel"]);
    assert.equal(await hasDeliveryCommit("worker", root, dataDir), true);
  } finally {
    await cleanup();
  }
});

test("an agent with only a Deliver-titled commit and no record is not proven delivered", async () => {
  const { repo, dataDir, cleanup } = await scratch();
  try {
    await commitFile(repo, "work.txt", "work\n", "Deliver worker");
    const root = await git(repo, ["rev-parse", "--show-toplevel"]);
    assert.equal(await hasDeliveryCommit("worker", root, dataDir), false);
  } finally {
    await cleanup();
  }
});

test("recording a delivery for a commit not on the target is refused and one on the target is written", async () => {
  const { repo, dataDir, cleanup } = await scratch();
  try {
    const spawn = await git(repo, ["rev-parse", "HEAD"]);
    await TREE_BASE_DATA.write(
      "worker",
      { name: "worker", base: "main", branch: "main", commit: spawn, repo, notedAt: new Date().toISOString() },
      dataDir,
    );
    await git(repo, ["checkout", "-b", "side"]);
    const offTarget = await commitFile(repo, "side.txt", "side\n", "Add the side file");
    await git(repo, ["checkout", "main"]);
    const refused = await recordCommand(["worker", "--commit", offTarget, "--data-dir", dataDir]);
    assert.equal(refused.code, 1);
    assert.match(refused.text, /not reachable from "worker"'s target branch "main"/);
    assert.equal(await DELIVERY_EVIDENCE_DATA.read("worker", dataDir), null);

    const onTarget = await commitFile(repo, "main.txt", "main\n", "Add the main file");
    const accepted = await recordCommand(["worker", "--commit", onTarget.slice(0, 12), "--data-dir", dataDir]);
    assert.equal(accepted.code, 0, accepted.text);
    const record = await DELIVERY_EVIDENCE_DATA.read("worker", dataDir);
    assert.equal(record?.commit, onTarget);
    assert.equal(record?.targetBranch, "main");
  } finally {
    await cleanup();
  }
});

test("an Alpha delivered as one commit after a soft reset passes the completion check", async () => {
  const { repo, dataDir, cleanup } = await scratch();
  try {
    const spawn = await git(repo, ["rev-parse", "HEAD"]);
    await TREE_BASE_DATA.write(
      "campaign",
      { name: "campaign", base: "main", branch: "main", commit: spawn, repo, notedAt: new Date().toISOString() },
      dataDir,
    );
    await git(repo, ["checkout", "-b", "campaign"]);
    await git(repo, ["checkout", "-b", "part"]);
    await commitFile(repo, "feature.txt", "feature\n", "Add the feature file");
    await git(repo, ["checkout", "campaign"]);
    await git(repo, ["merge", "--no-ff", "--no-edit", "--no-gpg-sign", "part"]);
    await git(repo, ["branch", "-D", "part"]);
    await git(repo, ["checkout", "main"]);
    await commitFile(repo, "elsewhere.txt", "elsewhere\n", "Add a file from other work");
    await git(repo, ["checkout", "campaign"]);
    await git(repo, ["merge", "--no-edit", "--no-gpg-sign", "main"]);
    const mergedTree = await git(repo, ["rev-parse", "HEAD^{tree}"]);
    await git(repo, ["reset", "--soft", "main"]);
    await git(repo, ["commit", "--no-gpg-sign", "-m", "Add the feature file"]);
    assert.equal(await git(repo, ["rev-parse", "HEAD^{tree}"]), mergedTree);
    await git(repo, ["checkout", "main"]);
    await git(repo, ["merge", "--ff-only", "campaign"]);
    const oneCommit = await git(repo, ["rev-parse", "main"]);

    const recorded = await recordCommand(["campaign", "--commit", oneCommit, "--data-dir", dataDir]);
    assert.equal(recorded.code, 0, recorded.text);
    const verdict = await checkDeliveryVerdict("campaign", dataDir);
    assert.equal(verdict.status, "delivered", JSON.stringify(verdict));
    const root = await git(repo, ["rev-parse", "--show-toplevel"]);
    assert.equal(await hasDeliveryCommit("campaign", root, dataDir), true);
  } finally {
    await cleanup();
  }
});
