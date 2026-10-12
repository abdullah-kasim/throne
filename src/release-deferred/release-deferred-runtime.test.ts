import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import {
  openRegentQueueStore,
  type RegentQueueItemRow,
} from "../regent-queue/regent-queue.store.ts";
import {
  ReleaseDeferredExitCode,
  run,
  type ReleaseDeferredDependencies,
} from "./release-deferred-runtime.ts";

const scratchDirectory = await mkdtemp(path.join(tmpdir(), "release-deferred-"));
after(() => rm(scratchDirectory, { recursive: true, force: true }));

let queueFileCount = 0;
function freshQueueFile(): string {
  queueFileCount += 1;
  return path.join(scratchDirectory, `queue-${queueFileCount}.sqlite3`);
}

interface Caller {
  readonly name: string | null;
  readonly role: string;
}

interface ReleaseRun {
  readonly exitCode: number;
  readonly messages: Array<{ recipient: string; message: string }>;
  readonly errors: string[];
}

async function releaseAs(caller: Caller, queueFile: string, args: string[]): Promise<ReleaseRun> {
  const messages: Array<{ recipient: string; message: string }> = [];
  const errors: string[] = [];
  const dependencies: ReleaseDeferredDependencies = {
    openStore: () => openRegentQueueStore(queueFile),
    currentAgentName: async () => {
      if (caller.name === null) throw new Error("no pane identity");
      return caller.name;
    },
    readRole: async () => ({ status: IdentityLineReadStatus.Found, value: caller.role }),
    sendMessage: async (recipient, message) => {
      messages.push({ recipient, message });
    },
    out: () => {},
    err: (message) => errors.push(message),
  };
  const exitCode = await run(args, dependencies);
  return { exitCode, messages, errors };
}

function fileRow(queueFile: string, objectiveCode: string, filedBy: string, deferred: boolean): void {
  const store = openRegentQueueStore(queueFile);
  try {
    const row = store.insertItem({ objectiveCode, body: `INTENT: ${objectiveCode}`, filedBy });
    if (deferred)
      store.mutateItem(row.id, {
        status: RegentQueueItemStatus.Deferred,
        deferral: { dependsOn: ["groundwork"], reason: "waits for the groundwork" },
      });
  } finally {
    store.close();
  }
}

function readRow(queueFile: string, objectiveCode: string): RegentQueueItemRow {
  const store = openRegentQueueStore(queueFile);
  try {
    return findQueueItemByObjectiveCode(store, objectiveCode)!;
  } finally {
    store.close();
  }
}

function readAuditEntries(queueFile: string): Array<{ actor: string; predicate: string; row_count: number }> {
  const database = new DatabaseSync(queueFile);
  try {
    return database
      .prepare("SELECT actor, predicate, row_count FROM queue_mutation_audit")
      .all() as unknown as Array<{ actor: string; predicate: string; row_count: number }>;
  } finally {
    database.close();
  }
}

const REGENT: Caller = { name: "Regent", role: "Regent" };
const FILING_STAGER: Caller = { name: "stager-first", role: "Stager" };
const releaseArguments = (code: string, ...rest: string[]): string[] => [
  "--objective-code",
  code,
  "--reason",
  "the groundwork is merged",
  ...rest,
];

test("the Regent can release a deferred row and the row becomes open", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "upper", FILING_STAGER.name!, true);
  const result = await releaseAs(REGENT, queueFile, releaseArguments("upper"));
  assert.equal(result.exitCode, ReleaseDeferredExitCode.Released, result.errors.join("\n"));
  const row = readRow(queueFile, "upper");
  assert.equal(row.status, RegentQueueItemStatus.Open);
  assert.equal(row.deferral, null);
});

test("releasing a deferred row records who asked, who released it and why on the row", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "upper", FILING_STAGER.name!, true);
  await releaseAs({ name: "regent", role: "Regent" }, queueFile, releaseArguments("upper", "--requested-by", "alpha-lower-01"));
  const release = readRow(queueFile, "upper").release;
  assert.equal(release?.requestedBy, "alpha-lower-01");
  assert.equal(release?.releasedBy, "Regent");
  assert.equal(release?.reason, "the groundwork is merged");
  assert.equal(typeof release?.releasedAt, "number");
});

test("releasing a deferred row writes one audit entry", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "upper", FILING_STAGER.name!, true);
  await releaseAs(REGENT, queueFile, releaseArguments("upper", "--requested-by", "alpha-lower-01"));
  const entries = readAuditEntries(queueFile);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.actor, "Regent");
  assert.equal(entries[0]!.row_count, 1);
  assert.match(entries[0]!.predicate, /upper/);
  assert.match(entries[0]!.predicate, /alpha-lower-01/);
  assert.match(entries[0]!.predicate, /the groundwork is merged/);
});

test("releasing a row that is not deferred is refused and changes nothing", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "ready", FILING_STAGER.name!, false);
  const before = readRow(queueFile, "ready");
  const result = await releaseAs(REGENT, queueFile, releaseArguments("ready", "--requested-by", "alpha-lower-01"));
  assert.equal(result.exitCode, ReleaseDeferredExitCode.Refused);
  assert.match(result.errors.join("\n"), /is "open", not "deferred"/);
  assert.deepEqual(readRow(queueFile, "ready"), before);
  assert.equal(readAuditEntries(queueFile).length, 0);
  assert.deepEqual(result.messages, []);
});

test("the Stager that filed a row can release it", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "upper", FILING_STAGER.name!, true);
  const result = await releaseAs(FILING_STAGER, queueFile, releaseArguments("upper"));
  assert.equal(result.exitCode, ReleaseDeferredExitCode.Released, result.errors.join("\n"));
  assert.equal(readRow(queueFile, "upper").release?.releasedBy, FILING_STAGER.name);
});

test("a Stager that did not file the row cannot release it", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "upper", FILING_STAGER.name!, true);
  const result = await releaseAs({ name: "stager-second", role: "Stager" }, queueFile, releaseArguments("upper"));
  assert.equal(result.exitCode, ReleaseDeferredExitCode.Refused);
  assert.match(result.errors.join("\n"), /only the Regent or the Stager that filed "upper" \(stager-first\)/);
  assert.equal(readRow(queueFile, "upper").status, RegentQueueItemStatus.Deferred);
});

test("an agent that is neither the Regent nor the filing Stager cannot release a row", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "upper", "alpha-named-filer-01", true);
  const alpha = await releaseAs({ name: "alpha-named-filer-01", role: "Alpha" }, queueFile, releaseArguments("upper"));
  const unidentified = await releaseAs({ name: null, role: "Stager" }, queueFile, releaseArguments("upper"));
  assert.equal(alpha.exitCode, ReleaseDeferredExitCode.Refused);
  assert.equal(unidentified.exitCode, ReleaseDeferredExitCode.Refused);
  assert.equal(readRow(queueFile, "upper").status, RegentQueueItemStatus.Deferred);
  assert.equal(readAuditEntries(queueFile).length, 0);
});

test("releasing with a requester sends that requester one message saying the row was released and why", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "upper", FILING_STAGER.name!, true);
  const result = await releaseAs(REGENT, queueFile, releaseArguments("upper", "--requested-by", "alpha-lower-01"));
  assert.deepEqual(result.messages, [
    { recipient: "alpha-lower-01", message: "Released upper: the groundwork is merged" },
  ]);
});

test("a malformed release request is refused before the queue is touched", async () => {
  const queueFile = freshQueueFile();
  fileRow(queueFile, "upper", FILING_STAGER.name!, true);
  for (const args of [
    releaseArguments("upper", "--released-by", "Regent"),
    ["--objective-code", "upper"],
    ["--objective-code", "NOT A CODE", "--reason", "x"],
  ]) {
    const result = await releaseAs(REGENT, queueFile, args);
    assert.equal(result.exitCode, ReleaseDeferredExitCode.Refused);
    assert.match(result.errors.join("\n"), /usage: throne release-deferred/);
  }
  assert.equal(readRow(queueFile, "upper").status, RegentQueueItemStatus.Deferred);
});
