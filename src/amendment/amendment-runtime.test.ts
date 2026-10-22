import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AGENT_LIFECYCLE_STATES } from "../agent-statuses/agent-statuses.types.ts";
import { IdentityLineReadStatus } from "../agentdata/identity-data.service.ts";
import { openMessageQueueStore } from "../message-queue/message-queue.store.ts";
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
} from "../send-agent/message-delivery-enqueue.ts";
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
  readonly messageFile: string;
}

function harness(
  dir: string,
  options: {
    caller?: string;
    callerRole?: string | null;
    goneAlphas?: readonly string[];
    startingAlphas?: readonly string[];
    rosterIsUnreadable?: boolean;
    unreachable?: readonly string[];
  } = {},
): Harness {
  const queueFile = path.join(dir, "queue.sqlite3");
  const messageFile = path.join(dir, "message-queue.sqlite3");
  const goneAlphas = options.goneAlphas ?? [];
  const startingAlphas = options.startingAlphas ?? [];
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
    readRoster: async () => {
      if (options.rosterIsUnreadable === true) throw new Error("herdr is not answering");
      return ["alpha-flying-01"]
        .filter((name) => !goneAlphas.includes(name) && !startingAlphas.includes(name))
        .map((name) => ({ name, lifecycle: AGENT_LIFECYCLE_STATES.LIVE, reportLanded: true, focused: false }));
    },
    spawnIsStillStarting: async (agentName) => startingAlphas.includes(agentName),
    readSupervisor: async () => ({ status: IdentityLineReadStatus.Found, value: "Regent" }),
    openMessageStore: () => openMessageQueueStore(messageFile),
    sendMessage: async (recipient, message) => {
      if ((options.unreachable ?? []).includes(recipient)) throw new Error("pane not found");
      sent.push({ recipient, message });
    },
    readTextFile: (filePath) => readFile(filePath, "utf8"),
    out: (message) => outputs.push(message),
    err: (message) => errors.push(message),
  };
  return { dependencies, sent, errors, outputs, queueFile, messageFile };
}

function fileRow(queueFile: string, objectiveCode: string, ...mutations: readonly QueueItemMutation[]): void {
  const store = openRegentQueueStore(queueFile);
  const row = store.insertItem({ objectiveCode, body: `INTENT: ${objectiveCode}` });
  for (const mutation of mutations) store.mutateItem(row.id, mutation);
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

function storeMessage(messageFile: string, senderName: string, recipientName: string, prompt: string): void {
  const store = openMessageQueueStore(messageFile);
  enqueueMessageDelivery(
    store,
    buildMessageDeliveryWorkItemPayload({
      recipientName,
      recipientPaneId: "pane-1",
      senderName,
      prompt,
      clearRecipientBlockedOnDelivery: false,
    }),
  );
  store.close();
}

function assertRefusedAndRecordedNowhere(
  h: Harness,
  objectiveCode: string,
  exitCode: number,
  ...expectedErrors: readonly RegExp[]
): void {
  assert.equal(exitCode, AmendmentExitCode.Refused);
  assert.deepEqual(recordedNumbers(h.queueFile, objectiveCode), []);
  assert.equal(h.sent.length, 0);
  for (const expectedError of expectedErrors) assert.match(h.errors.join(""), expectedError);
}

async function amendRowWhoseAlphaSent(h: Harness, objectiveCode: string, prompt: string): Promise<number> {
  fileRow(h.queueFile, objectiveCode, IN_FLIGHT);
  storeMessage(h.messageFile, "alpha-flying-01", "regent", prompt);
  return run(["--objective-code", objectiveCode, ...LORD_SAYS], h.dependencies);
}

const REFUSED_AS_DONE = [/File a NEW objective/, /alpha-flying-01 has reported DONE to its supervisor/];

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

test("an amendment on a row sent back to open after its Alpha stopped is recorded before the relaunch", async () => {
  for (const options of [{ goneAlphas: ["alpha-flying-01"] }, { rosterIsUnreadable: true }]) {
    await withTempDir(async (dir) => {
      const h = harness(dir, options);
      fileRow(h.queueFile, "relaunching", IN_FLIGHT, { status: "open" });
      const exitCode = await run(["--objective-code", "relaunching", ...LORD_SAYS], h.dependencies);
      assert.equal(exitCode, AmendmentExitCode.Recorded, h.errors.join("\n"));
      assert.deepEqual(recordedNumbers(h.queueFile, "relaunching"), [1]);
      assert.equal(h.sent.length, 0);
    });
  }
});

test("an amendment on an in-flight row whose live Alpha keeps a partial REPORT.md is recorded and the Alpha and the Regent are told", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "reporting", IN_FLIGHT);
    storeMessage(h.messageFile, "alpha-flying-01", "regent", "Progress: REPORT.md updated, slice 2 of 4 running");
    const exitCode = await run(["--objective-code", "reporting", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Recorded, h.errors.join("\n"));
    assert.deepEqual(recordedNumbers(h.queueFile, "reporting"), [1]);
    assert.deepEqual(h.sent.map((delivery) => delivery.recipient), ["alpha-flying-01", "Regent"]);
  });
});

test("an amendment on a row whose Alpha has reported DONE to its supervisor is refused and recorded nowhere", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    fileRow(h.queueFile, "finished", IN_FLIGHT);
    storeMessage(h.messageFile, "alpha-flying-01", "regent", "DONE: merged into main at c2603cd");
    const exitCode = await run(["--objective-code", "finished", ...LORD_SAYS], h.dependencies);
    assertRefusedAndRecordedNowhere(h, "finished", exitCode, ...REFUSED_AS_DONE);
  });
});

test("an amendment is refused when the Alpha's DONE report starts with its own name", async () => {
  for (const prompt of [
    "alpha-flying-01: DONE flying. Delivered to local main 4be1c0d",
    "alpha-flying-01 DONE. Draft Forgejo PR 25",
  ]) {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const exitCode = await amendRowWhoseAlphaSent(h, "flying", prompt);
      assertRefusedAndRecordedNowhere(h, "flying", exitCode, ...REFUSED_AS_DONE);
    });
  }
});

test("an amendment is refused when the Alpha's DONE report starts with its objective code", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    const exitCode = await amendRowWhoseAlphaSent(h, "flying", "flying DONE. Conformance PASS, Verify PASS, Delivery PASS");
    assertRefusedAndRecordedNowhere(h, "flying", exitCode, ...REFUSED_AS_DONE);
  });
});

test("a progress note that mentions DONE later in the text does not count as the Alpha's DONE report", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    const exitCode = await amendRowWhoseAlphaSent(h, "flying", "flying: 02 and 05 DONE and merged (no-op). 03 running");
    assert.equal(exitCode, AmendmentExitCode.Recorded, h.errors.join("\n"));
    assert.deepEqual(recordedNumbers(h.queueFile, "flying"), [1]);
  });
});

test("an amendment on a row whose Alpha is no longer live is refused even though it wrote REPORT.md", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir, { goneAlphas: ["alpha-flying-01"] });
    fileRow(h.queueFile, "abandoned-by-alpha", IN_FLIGHT);
    const exitCode = await run(["--objective-code", "abandoned-by-alpha", ...LORD_SAYS], h.dependencies);
    assertRefusedAndRecordedNowhere(
      h,
      "abandoned-by-alpha",
      exitCode,
      /File a NEW objective/,
      /alpha-flying-01 is no longer live/,
    );
  });
});

test("an amendment recorded while the Alpha's spawn is still starting is accepted", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir, { startingAlphas: ["alpha-flying-01"] });
    fileRow(h.queueFile, "launching", IN_FLIGHT);
    const exitCode = await run(["--objective-code", "launching", ...LORD_SAYS], h.dependencies);
    assert.equal(exitCode, AmendmentExitCode.Recorded, h.errors.join("\n"));
    assert.deepEqual(recordedNumbers(h.queueFile, "launching"), [1]);
  });
});

test("an amendment is refused and recorded nowhere when its Alpha's liveness cannot be read", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir, { rosterIsUnreadable: true });
    fileRow(h.queueFile, "flying", IN_FLIGHT);
    const exitCode = await run(["--objective-code", "flying", ...LORD_SAYS], h.dependencies);
    assertRefusedAndRecordedNowhere(
      h,
      "flying",
      exitCode,
      /could not read whether its Alpha alpha-flying-01 is live: herdr is not answering/,
    );
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
    assertRefusedAndRecordedNowhere(h, "flying", exitCode, /only a Stager or the Regent/);
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
