import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { openRegentQueueAmendments } from "../regent-queue/regent-queue-amendments.ts";
import { openRegentQueueStore, type QueueItemMutation } from "../regent-queue/regent-queue.store.ts";
import {
  MAXIMUM_NOTICE_LENGTH,
  RECONCILED_THROUGH_LABEL,
} from "./amendment-notices.ts";
import {
  AmendmentExitCode,
  run,
  type AmendmentDependencies,
} from "./amendment-runtime.ts";

async function withTempDir(runInside: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "amendment-runtime-"));
  try {
    await runInside(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Harness {
  readonly dependencies: AmendmentDependencies;
  readonly sent: Array<{ recipient: string; message: string }>;
  readonly errors: string[];
  readonly outputs: string[];
  readonly queueFile: string;
}

function harness(
  dir: string,
  options: {
    caller?: string;
    callerRole?: string | null;
    reportWrittenBy?: readonly string[];
    unreachable?: readonly string[];
  } = {},
): Harness {
  const queueFile = path.join(dir, "queue.sqlite3");
  const sent: Array<{ recipient: string; message: string }> = [];
  const errors: string[] = [];
  const outputs: string[] = [];
  const callerRole = options.callerRole === undefined ? "Stager" : options.callerRole;
  const dependencies: AmendmentDependencies = {
    openStore: () => openRegentQueueStore(queueFile),
    openAmendments: () => openRegentQueueAmendments(queueFile),
    currentAgentName: async () => options.caller ?? "stager-test",
    readRole: async () =>
      callerRole === null
        ? { status: IdentityLineReadStatus.FieldAbsent }
        : { status: IdentityLineReadStatus.Found, value: callerRole },
    hasWrittenItsReport: async (agentName) => (options.reportWrittenBy ?? []).includes(agentName),
    sendMessage: async (recipient, message) => {
      if ((options.unreachable ?? []).includes(recipient)) throw new Error("pane not found");
      sent.push({ recipient, message });
    },
    readTextFile: (filePath) => readFile(filePath, "utf8"),
    out: (message) => outputs.push(message),
    err: (message) => errors.push(message),
  };
  return { dependencies, sent, errors, outputs, queueFile };
}

function fileRow(queueFile: string, objectiveCode: string, mutation?: QueueItemMutation): void {
  const store = openRegentQueueStore(queueFile);
  const row = store.insertItem({ objectiveCode, body: `INTENT: ${objectiveCode}` });
  if (mutation !== undefined) store.mutateItem(row.id, mutation);
  store.close();
}

const IN_FLIGHT: QueueItemMutation = {
  status: "in-flight",
  agentName: "alpha-flying-01",
  targetRepo: "/tmp/repo",
  baseCommit: "abc123",
};

function recordedNumbers(queueFile: string, objectiveCode: string): number[] {
  const amendments = openRegentQueueAmendments(queueFile);
  const numbers = amendments.readForObjective(objectiveCode).map((amendment) => amendment.number);
  amendments.close();
  return numbers;
}

const LORD_SAYS = ["--words-of", "Lord", "--text", "no retries on 429"];

test("a Stager's amendment on an in-flight row is recorded and both its Alpha and the Regent are told with a short pointer", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "flying", IN_FLIGHT);
    const exitCode = await run(["--objective-code", "flying", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Recorded, h.errors.join("\n"));
    assert.deepEqual(recordedNumbers(h.queueFile, "flying"), [1]);
    assert.deepEqual(h.sent.map((delivery) => delivery.recipient), ["alpha-flying-01", "Regent"]);
    for (const { message } of h.sent) {
      assert.ok(message.length <= MAXIMUM_NOTICE_LENGTH, `${message.length}: ${message}`);
      assert.match(message, /AMENDMENT 1/);
    }
    assert.ok(h.sent[0]!.message.includes(`${RECONCILED_THROUGH_LABEL} 1`));
    assert.match(h.outputs.join(""), /told alpha-flying-01 and the Regent/);
  });
});

test("a second amendment is numbered 2 and its notices say so", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "flying", IN_FLIGHT);
    await run(["--objective-code", "flying", ...LORD_SAYS], h.dependencies);
    await run(["--objective-code", "flying", "--words-of", "Lord", "--text", "save the back-off"], h.dependencies);
    assert.deepEqual(recordedNumbers(h.queueFile, "flying"), [1, 2]);
    assert.match(h.sent[2]!.message, /AMENDMENT 2/);
    assert.ok(h.sent[2]!.message.includes(`${RECONCILED_THROUGH_LABEL} 2`));
  });
});

test("the Regent recording an amendment tells only the Alpha, never itself", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir, { caller: "regent", callerRole: null });
    fileRow(h.queueFile, "flying", IN_FLIGHT);
    const exitCode = await run(["--objective-code", "flying", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Recorded, h.errors.join("\n"));
    assert.deepEqual(h.sent.map((delivery) => delivery.recipient), ["alpha-flying-01"]);
  });
});

test("an amendment on a row that has not launched is recorded and nobody is messaged", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "waiting");
    const exitCode = await run(["--objective-code", "waiting", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Recorded);
    assert.deepEqual(recordedNumbers(h.queueFile, "waiting"), [1]);
    assert.equal(h.sent.length, 0);
    assert.match(h.outputs.join(""), /situation brief/);
  });
});

test("an in-flight row whose Alpha already wrote REPORT.md is refused, recorded nowhere, and nobody is messaged", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir, { reportWrittenBy: ["alpha-flying-01"] });
    fileRow(h.queueFile, "finished", IN_FLIGHT);
    const exitCode = await run(["--objective-code", "finished", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Refused);
    assert.deepEqual(recordedNumbers(h.queueFile, "finished"), []);
    assert.equal(h.sent.length, 0);
    assert.match(h.errors.join(""), /REPORT\.md/);
    assert.match(h.errors.join(""), /File a NEW objective/);
  });
});

test("a row with a recorded delivery commit is refused and the refusal names the branch and commit", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "shipped", { ...IN_FLIGHT, deliveryCommit: "c2603cd" });
    const exitCode = await run(["--objective-code", "shipped", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Refused);
    assert.deepEqual(recordedNumbers(h.queueFile, "shipped"), []);
    assert.match(h.errors.join(""), /c2603cd/);
  });
});

test("complete and abandoned rows are refused", async () => {
  for (const status of ["complete", "abandoned"] as const) {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      fileRow(h.queueFile, "done", IN_FLIGHT);
      const store = openRegentQueueStore(h.queueFile);
      const all = store.readAll();
      const id = all.state === "items" ? all.items[0]!.id : "";
      store.mutateItem(id, { status });
      store.close();
      const exitCode = await run(["--objective-code", "done", ...LORD_SAYS], h.dependencies);
      assert.equal(exitCode, AmendmentExitCode.Refused, status);
      assert.deepEqual(recordedNumbers(h.queueFile, "done"), [], status);
      assert.equal(h.sent.length, 0, status);
    });
  }
});

test("an unknown objective code is refused with a pointer to queue-objective", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "real");
    const exitCode = await run(["--objective-code", "ghost", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Refused);
    assert.match(h.errors.join(""), /no queue row is named "ghost"/);
  });
});

test("an Alpha may not record an amendment; nothing is recorded or sent", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir, { caller: "alpha-other-01", callerRole: "Alpha" });
    fileRow(h.queueFile, "flying", IN_FLIGHT);
    const exitCode = await run(["--objective-code", "flying", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Refused);
    assert.deepEqual(recordedNumbers(h.queueFile, "flying"), []);
    assert.equal(h.sent.length, 0);
    assert.match(h.errors.join(""), /only a Stager or the Regent/);
  });
});

test("malformed invocations are refused before anything is read or written", async () => {
  const cases: Array<[string, string[], RegExp]> = [
    ["unknown flag", ["--objective-code", "flying", "--words-of", "Lord", "--text", "x", "--urgent"], /unknown argument "--urgent"/],
    ["missing words-of", ["--objective-code", "flying", "--text", "x"], /--words-of is required/],
    ["both text sources", ["--objective-code", "flying", "--words-of", "Lord", "--text", "x", "--text-file", "y"], /exactly one of --text or --text-file/],
    ["invalid code", ["--objective-code", "not a code!", "--words-of", "Lord", "--text", "x"], /valid --objective-code/],
    ["empty text", ["--objective-code", "flying", "--words-of", "Lord", "--text", "   "], /requires a non-empty value/],
  ];
  for (const [label, args, expected] of cases) {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      fileRow(h.queueFile, "flying", IN_FLIGHT);
      const exitCode = await run(args, h.dependencies);
      assert.equal(exitCode, AmendmentExitCode.Refused, label);
      assert.match(h.errors.join(""), expected, label);
      assert.deepEqual(recordedNumbers(h.queueFile, "flying"), [], label);
      assert.equal(h.sent.length, 0, label);
    });
  }
});

test("the amendment text can come from a file", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "flying", IN_FLIGHT);
    const textFile = path.join(dir, "amendment.md");
    await writeFile(textFile, "\nRename every setting to TRACE_QUERY_.\n");
    const exitCode = await run(["--objective-code", "flying", "--words-of", "Lord", "--text-file", textFile], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Recorded, h.errors.join("\n"));
    const amendments = openRegentQueueAmendments(h.queueFile);
    assert.equal(amendments.readForObjective("flying")[0]!.text, "Rename every setting to TRACE_QUERY_.");
    amendments.close();
  });
});

test("when a recipient cannot be reached the amendment stays recorded and the failure is loud", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir, { unreachable: ["alpha-flying-01"] });
    fileRow(h.queueFile, "flying", IN_FLIGHT);
    const exitCode = await run(["--objective-code", "flying", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.RecordedButNotEveryoneWasTold);
    assert.deepEqual(recordedNumbers(h.queueFile, "flying"), [1]);
    assert.deepEqual(h.sent.map((delivery) => delivery.recipient), ["Regent"]);
    assert.match(h.errors.join(""), /NOT told: alpha-flying-01 \(pane not found\)/);
  });
});

test("an in-flight row with no Alpha recorded still tells the Regent and exits as not everyone told", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "orphan", { status: "in-flight" });
    const exitCode = await run(["--objective-code", "orphan", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.RecordedButNotEveryoneWasTold);
    assert.deepEqual(h.sent.map((delivery) => delivery.recipient), ["Regent"]);
    assert.match(h.sent[0]!.message, /NO Alpha is recorded/);
  });
});
