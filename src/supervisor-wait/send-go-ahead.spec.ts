import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ACCEPTANCE_DATA } from "../agentdata/acceptance-data.service.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import { run as runAcceptSlice } from "../accept-slice/accept-slice-runtime.ts";
import { run as runMergeGitTree, type MergeGitTreeDeps } from "../merge-git-tree/merge-git-tree-runtime.ts";
import { readSupervisorWait, SUPERVISOR_WAIT_STEPS } from "./read-supervisor-wait.ts";
import { sendGoAheadAfterMerge, type GoAheadDependencies } from "./send-go-ahead.ts";

const ALPHA = "alpha-scratch-02";
const SHADOW = "shadow-scratch-02-slice";
const ACCEPTED_AT = new Date("2026-11-11T11:00:00.000Z");

interface SentMessage {
  readonly recipient: string;
  readonly sender: string;
  readonly prompt: string;
}

function fakeGoAhead(sent: SentMessage[], options: { failSend?: boolean } = {}): GoAheadDependencies {
  return {
    resolveAgent: async (name) => ({ name, paneId: "w9:p9" }) as HerdrAgent,
    submitToAgent: async (target, sender, prompt) => {
      if (options.failSend === true) throw new Error("queue unavailable");
      sent.push({ recipient: target.name ?? "", sender, prompt });
    },
    now: () => ACCEPTED_AT,
  };
}

async function withShadowLedger(run: (dataDir: string) => Promise<void>, role = "Shadow"): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "go-ahead-"));
  try {
    const dir = path.join(dataDir, SHADOW);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "identity.md"),
      `# ${SHADOW}\n\n- **Role:** ${role}\n- **Supervisor (routine):** ${ALPHA}\n`,
    );
    await writeFile(path.join(dir, "REPORT.md"), "DONE\n");
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function mergeDependencies(goAhead: GoAheadDependencies, output: string[]): MergeGitTreeDeps {
  return {
    readTreeMergeTarget: async () => ({ repo: "/scratch/repo", branch: ALPHA }),
    refuseUnreconciledQueueAmendments: async () => undefined,
    withTargetDeliveryLock: async (_repo, _holder, _dataDir, operation) => operation(),
    absorbDeliveryTarget: async () => ({ status: "up-to-date" }) as never,
    mergeBack: async () => ({ noop: false, branch: ALPHA, commit: "abc1234" }) as never,
    validateDelivery: async () => ({ status: "delivered" }) as never,
    sendGoAheadAfterMerge: (name, dataDir) => sendGoAheadAfterMerge(name, dataDir, goAhead),
    out: (message) => output.push(message),
    err: (message) => output.push(message),
  };
}

function acceptDependencies(goAhead: GoAheadDependencies, output: string[], caller = ALPHA) {
  return {
    currentAgentName: async () => caller,
    goAhead,
    out: (message: string) => output.push(message),
    err: (message: string) => output.push(message),
  };
}

test("merging a Shadow's tree sends it the go-ahead and records it", async () => {
  await withShadowLedger(async (dataDir) => {
    const sent: SentMessage[] = [];
    const output: string[] = [];
    const exitCode = await runMergeGitTree(
      ["--data-dir", dataDir, SHADOW, "Add the report reader"],
      mergeDependencies(fakeGoAhead(sent), output),
    );
    assert.equal(exitCode, 0, output.join(""));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.recipient, SHADOW);
    assert.equal(sent[0]!.sender, ALPHA);
    assert.match(sent[0]!.prompt, /may now run `throne my-state reapable completed` and publish your reapability claim/);
    const record = await ACCEPTANCE_DATA.read(SHADOW, dataDir);
    assert.equal(record?.how, "merge");
    assert.equal(record?.by, ALPHA);
    assert.equal(record?.goAhead?.sendOutcome, "enqueued");
    const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
    assert.equal(wait.waiting && wait.step, SUPERVISOR_WAIT_STEPS.GO_AHEAD_SENT_AWAITING_CLAIM);
  });
});

test("a failed go-ahead send is recorded and the merge still succeeds", async () => {
  await withShadowLedger(async (dataDir) => {
    const output: string[] = [];
    const exitCode = await runMergeGitTree(
      ["--data-dir", dataDir, SHADOW, "Add the report reader"],
      mergeDependencies(fakeGoAhead([], { failSend: true }), output),
    );
    assert.equal(exitCode, 0);
    assert.match(output.join(""), /go-ahead to "shadow-scratch-02-slice" FAILED \(queue unavailable\)/);
    const record = await ACCEPTANCE_DATA.read(SHADOW, dataDir);
    assert.equal(record?.goAhead?.sendOutcome, "failed");
    assert.equal(record?.goAhead?.error, "queue unavailable");
    const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
    assert.equal(wait.waiting && wait.step, SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD);
  });
});

test("merging a tree that is not a Shadow's sends no go-ahead and records nothing", async () => {
  await withShadowLedger(async (dataDir) => {
    const sent: SentMessage[] = [];
    const output: string[] = [];
    const exitCode = await runMergeGitTree(
      ["--data-dir", dataDir, SHADOW, "Add the report reader"],
      mergeDependencies(fakeGoAhead(sent), output),
    );
    assert.equal(exitCode, 0, output.join(""));
    assert.deepEqual(sent, []);
    assert.equal(await ACCEPTANCE_DATA.read(SHADOW, dataDir), null);
  }, "Alpha");
});

test("accepting a verdict-only slice sends the go-ahead without touching git", async () => {
  await withShadowLedger(async (dataDir) => {
    const sent: SentMessage[] = [];
    const output: string[] = [];
    const before = await readdir(path.join(dataDir, SHADOW));
    const exitCode = await runAcceptSlice(
      ["--data-dir", dataDir, SHADOW],
      acceptDependencies(fakeGoAhead(sent), output),
    );
    assert.equal(exitCode, 0, output.join(""));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.recipient, SHADOW);
    assert.match(sent[0]!.prompt, /accepted as a verdict by alpha-scratch-02/);
    const after = await readdir(path.join(dataDir, SHADOW));
    assert.deepEqual(after.filter((file) => !before.includes(file)), ["acceptance.json"]);
    const record = await ACCEPTANCE_DATA.read(SHADOW, dataDir);
    assert.equal(record?.how, "verdict");
    assert.equal(record?.goAhead?.sendOutcome, "enqueued");
    const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
    assert.equal(wait.waiting && wait.step, SUPERVISOR_WAIT_STEPS.GO_AHEAD_SENT_AWAITING_CLAIM);
  });
});

test("a failed go-ahead on a verdict-only acceptance is recorded and reported", async () => {
  await withShadowLedger(async (dataDir) => {
    const output: string[] = [];
    const exitCode = await runAcceptSlice(
      ["--data-dir", dataDir, SHADOW],
      acceptDependencies(fakeGoAhead([], { failSend: true }), output),
    );
    assert.equal(exitCode, 1);
    assert.match(output.join(""), /go-ahead FAILED \(queue unavailable\)/);
    const record = await ACCEPTANCE_DATA.read(SHADOW, dataDir);
    assert.equal(record?.how, "verdict");
    assert.equal(record?.goAhead?.sendOutcome, "failed");
  });
});

test("only the Shadow's own supervisor can accept its slice", async () => {
  await withShadowLedger(async (dataDir) => {
    const sent: SentMessage[] = [];
    const output: string[] = [];
    const refused = await runAcceptSlice(
      ["--data-dir", dataDir, SHADOW],
      acceptDependencies(fakeGoAhead(sent), output, "alpha-someone-else"),
    );
    assert.equal(refused, 1);
    assert.match(output.join(""), /--bypass-supervisor-check/);
    assert.deepEqual(sent, []);
    assert.equal(await ACCEPTANCE_DATA.read(SHADOW, dataDir), null);
    const sentOnBypass: SentMessage[] = [];
    const bypassed = await runAcceptSlice(
      ["--data-dir", dataDir, "--bypass-supervisor-check", SHADOW],
      acceptDependencies(fakeGoAhead(sentOnBypass), [], "alpha-someone-else"),
    );
    assert.equal(bypassed, 0);
    assert.equal(sentOnBypass[0]!.sender, ALPHA);
  });
});
