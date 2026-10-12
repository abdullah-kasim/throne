import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NestCommanderApplicationModule } from "../application.module.ts";
import {
  assertCommandRegistryCoverage,
  classifyCommandRegistryCoverage,
  discoverCommandProviders,
  INTENTIONAL_COMMAND_REGISTRY_EXCEPTIONS,
} from "../command-registry-coverage/command-registry-coverage.ts";
import {
  assertEntranceSteeringCoverage,
  parseEntranceSteeringAudit,
  verifyEntranceSteeringEvidence,
} from "../command-registry-coverage/entrance-steering-coverage.ts";
import { ENTRANCE_STEERING_EXECUTABLE_EVIDENCE } from "../command-registry-coverage/entrance-steering-evidence.ts";
import {
  MESSAGE_RETENTION_WINDOW_MS,
  MessageQueueWorkItemState,
  openMessageQueueStore,
  type MessageQueueStore,
} from "../message-queue/message-queue.store.ts";
import {
  buildMessageDeliveryWorkItemPayload,
  enqueueMessageDelivery,
} from "../send-agent/message-delivery-enqueue.ts";
import { COMMAND_REGISTRY } from "../shared-policy/command-registry.ts";
import { ReadMessageCommand } from "./read-message.command.ts";
import { READ_MESSAGE_EXIT, runReadMessage } from "./read-message.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
const RECIPIENT_NAME = "shadow-bakery-01-oven";
const SENDER_NAME = "alpha-bakery-01";
const BYSTANDER_NAME = "shadow-bakery-02-photos";
const STORED_PROMPT = "Bake the sourdough first.\n\nThen photograph   the crumb.";

interface MessageRoom {
  readonly store: MessageQueueStore;
  readonly effects: { storeOpenings: number; identityLookups: number };
  advanceClockBy(milliseconds: number): void;
  storeMessage(overrides?: { omitSenderAttribution: boolean }): number;
  read(args: readonly string[], callerName: string): Promise<CommandOutcome>;
}

interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function withMessageRoom(run: (room: MessageRoom) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "throne-read-message-"));
  const databasePath = path.join(directory, "queue.sqlite3");
  let now = 1_000;
  const store = openMessageQueueStore(databasePath, () => now);
  const effects = { storeOpenings: 0, identityLookups: 0 };
  try {
    await run({
      store,
      effects,
      advanceClockBy: (milliseconds) => {
        now += milliseconds;
      },
      storeMessage: (overrides) =>
        enqueueMessageDelivery(
          store,
          buildMessageDeliveryWorkItemPayload({
            recipientName: RECIPIENT_NAME,
            recipientPaneId: "pane-oven",
            senderName: SENDER_NAME,
            prompt: STORED_PROMPT,
            clearRecipientBlockedOnDelivery: false,
            ...overrides,
          }),
        ).id,
      read: async (args, callerName) => {
        let stdout = "";
        let stderr = "";
        const exitCode = await runReadMessage(args, {
          openStore: () => {
            effects.storeOpenings += 1;
            return openMessageQueueStore(databasePath, () => now);
          },
          resolveCurrentAgentName: async () => {
            effects.identityLookups += 1;
            return callerName;
          },
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        });
        return { exitCode, stdout, stderr };
      },
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function assertNothingPrinted(outcome: CommandOutcome, expectedComplaint: RegExp): void {
  assert.equal(outcome.exitCode, READ_MESSAGE_EXIT.NotPrinted);
  assert.equal(outcome.stdout, "");
  assert.match(outcome.stderr, expectedComplaint);
  assert.equal(outcome.stderr.trimEnd().includes("\n"), false);
}

test("an agent can read the full text of a message addressed to it by its id", async () => {
  await withMessageRoom(async (room) => {
    const messageId = room.storeMessage();
    const outcome = await room.read([String(messageId)], RECIPIENT_NAME);
    assert.deepEqual(outcome, {
      exitCode: READ_MESSAGE_EXIT.Printed,
      stdout: `${SENDER_NAME} said: ${STORED_PROMPT}\n`,
      stderr: "",
    });
  });
});

test("the sender of a message can read it back by its id", async () => {
  await withMessageRoom(async (room) => {
    const messageId = room.storeMessage();
    const outcome = await room.read([String(messageId)], SENDER_NAME);
    assert.equal(outcome.exitCode, READ_MESSAGE_EXIT.Printed);
    assert.equal(outcome.stdout, `${SENDER_NAME} said: ${STORED_PROMPT}\n`);
  });
});

test("an agent whose name differs from the stored one only in letter case can read its own message", async () => {
  await withMessageRoom(async (room) => {
    const messageId = room.storeMessage();
    for (const callerName of [RECIPIENT_NAME.toUpperCase(), SENDER_NAME.toUpperCase()]) {
      const outcome = await room.read([String(messageId)], callerName);
      assert.equal(outcome.exitCode, READ_MESSAGE_EXIT.Printed);
      assert.equal(outcome.stdout, `${SENDER_NAME} said: ${STORED_PROMPT}\n`);
    }
  });
});

test("a message stored without sender attribution prints as its prompt alone", async () => {
  await withMessageRoom(async (room) => {
    const messageId = room.storeMessage({ omitSenderAttribution: true });
    const outcome = await room.read([String(messageId)], RECIPIENT_NAME);
    assert.equal(outcome.exitCode, READ_MESSAGE_EXIT.Printed);
    assert.equal(outcome.stdout, `${STORED_PROMPT}\n`);
  });
});

test("reading a message twice prints the same text and leaves the stored row unchanged", async () => {
  await withMessageRoom(async (room) => {
    const messageId = room.storeMessage();
    const rowBeforeReading = room.store.readWorkItem(messageId);
    const firstReading = await room.read([String(messageId)], RECIPIENT_NAME);
    room.advanceClockBy(60_000);
    const secondReading = await room.read([String(messageId)], RECIPIENT_NAME);
    assert.equal(firstReading.exitCode, READ_MESSAGE_EXIT.Printed);
    assert.deepEqual(secondReading, firstReading);
    assert.deepEqual(room.store.readWorkItem(messageId), rowBeforeReading);
  });
});

test("reading an id that is unknown or already swept says the message is no longer stored and fails", async () => {
  await withMessageRoom(async (room) => {
    const noLongerStored = /^read-message: message \d+ is no longer stored \(rows are swept 2 days after they finish\)\n$/;
    assertNothingPrinted(await room.read(["987654"], RECIPIENT_NAME), noLongerStored);

    const otherWork = room.store.insertWorkItem({
      kind: "oven-inspection",
      payload: { recipientName: RECIPIENT_NAME, senderName: SENDER_NAME, prompt: STORED_PROMPT },
    });
    assertNothingPrinted(await room.read([String(otherWork.id)], RECIPIENT_NAME), noLongerStored);

    const messageId = room.storeMessage();
    room.store.claimDueWorkItem(messageId);
    room.store.transitionWorkItemState(messageId, MessageQueueWorkItemState.Delivered);
    assert.equal((await room.read([String(messageId)], RECIPIENT_NAME)).exitCode, READ_MESSAGE_EXIT.Printed);
    room.advanceClockBy(MESSAGE_RETENTION_WINDOW_MS + 1);
    assert.equal(room.store.sweepExpiredTerminalWorkItems().sweptCount, 1);
    assertNothingPrinted(await room.read([String(messageId)], RECIPIENT_NAME), noLongerStored);
  });
});

test("an agent that neither sent nor received a message is refused its text", async () => {
  await withMessageRoom(async (room) => {
    const messageId = room.storeMessage();
    const outcome = await room.read([String(messageId)], BYSTANDER_NAME);
    assertNothingPrinted(outcome, /^read-message: refused, message \d+ was neither sent by nor addressed to shadow-bakery-02-photos\n$/);
    assert.equal(outcome.stderr.includes(STORED_PROMPT), false);
  });
});

test("read-message steers malformed input before identity or store effects", async () => {
  await withMessageRoom(async (room) => {
    for (const malformedArguments of [[], ["0"], ["seven"], ["12", "13"], ["--unknown"]]) {
      const outcome = await room.read(malformedArguments, RECIPIENT_NAME);
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.stdout, "");
      assert.match(outcome.stderr, /Usage: throne read-message <message-id>/);
      assert.match(outcome.stderr, /requires exactly one message ID/);
      assert.match(outcome.stderr, /No bypass is available for this refusal/);
      assert.match(outcome.stderr, /Ask your supervisor for an allowed alternative invocation/);
    }
    assert.deepEqual(room.effects, { storeOpenings: 0, identityLookups: 0 });
  });
});

test("the read-message command is registered and dispatchable", async () => {
  const registered = COMMAND_REGISTRY.map((entry) => ({
    name: entry.name,
    providerName: entry.provider.name,
    sourcePath: "",
  }));
  assertCommandRegistryCoverage(
    classifyCommandRegistryCoverage(
      await discoverCommandProviders(path.join(REPOSITORY_ROOT, "src")),
      registered,
      INTENTIONAL_COMMAND_REGISTRY_EXCEPTIONS,
    ),
  );
  const registryEntry = COMMAND_REGISTRY.find((entry) => entry.name === "read-message");
  assert.equal(registryEntry?.provider, ReadMessageCommand);
  assert.equal(registryEntry?.visibility, "public");

  const moduleProviders = Reflect.getMetadata("providers", NestCommanderApplicationModule) as readonly unknown[];
  assert.equal(
    moduleProviders.filter(
      (provider) =>
        provider === ReadMessageCommand ||
        (typeof provider === "object" && provider !== null && "provide" in provider && provider.provide === ReadMessageCommand),
    ).length,
    1,
  );

  const auditRows = parseEntranceSteeringAudit(
    await readFile(path.join(REPOSITORY_ROOT, "agent_docs", "command-entry-steering-audit.md"), "utf8"),
  ).filter((row) => row.commandName === "read-message");
  assertEntranceSteeringCoverage([registryEntry!], auditRows);
  await verifyEntranceSteeringEvidence(
    REPOSITORY_ROOT,
    auditRows,
    ENTRANCE_STEERING_EXECUTABLE_EVIDENCE.filter((evidence) => evidence.commandName === "read-message"),
  );
});
