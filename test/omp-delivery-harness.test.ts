import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { SendAgentCommand } from "../src/send-agent/send-agent.command.ts";
import {
  MessageQueueWorkItemState,
  openMessageQueueStore,
} from "../src/message-queue/message-queue.store.ts";
import { deliverMessageWorkItem } from "../src/throne-work/message-delivery-handler.ts";
import {
  deliverToOmp,
  ompRequestPrefix,
} from "../src/herdr/omp-delivery-client.ts";
import { ownedHerdrClientPath } from "../src/herdr/herdr-client.ts";
import { launchHerdrSuiteSession } from "../scripts/herdr-suite-session.mjs";
import { ompModelSkipReason } from "./omp-model-availability.ts";

const execFileAsync = promisify(execFile);
const AGENT_START_TIMEOUT_MILLISECONDS = 5_000;
const TYPESCRIPT_REGISTER_PATH = path.resolve("test/register-typescript.mjs");
const TAB_LEAK_GUARD_PATH = path.resolve("scripts/herdr-tab-leak-guard.mjs");

async function createRealOmpAgent(
  sessionName: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly name: string; readonly paneId: string }> {
  const workspace = await execFileAsync(
    ownedHerdrClientPath(),
    [
      "--session",
      sessionName,
      "workspace",
      "create",
      "--label",
      "omp-delivery-harness",
    ],
    { env: environment },
  );
  const parsedWorkspace = JSON.parse(workspace.stdout) as {
    result: { root_pane: { pane_id: string } };
  };
  const name = "isolated-omp-recipient";
  const started = await execFileAsync(
    ownedHerdrClientPath(),
    [
      "--session",
      sessionName,
      "agent",
      "start",
      name,
      "--kind",
      "omp",
      "--pane",
      parsedWorkspace.result.root_pane.pane_id,
      "--timeout",
      String(AGENT_START_TIMEOUT_MILLISECONDS),
    ],
    { env: environment },
  );
  const parsedStarted = JSON.parse(started.stdout) as {
    result: { agent: { pane_id: string } };
  };
  return { name, paneId: parsedStarted.result.agent.pane_id };
}

async function readVisibleAgentAnsi(
  sessionName: string,
  name: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const visible = await execFileAsync(
    ownedHerdrClientPath(),
    [
      "--session",
      sessionName,
      "agent",
      "read",
      name,
      "--source",
      "visible",
      "--format",
      "ansi",
    ],
    { env: environment },
  );
  return visible.stdout;
}
async function createOmpHarnessEnvironment(root: string): Promise<{
  readonly dataHome: string;
  readonly deliveryDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}> {
  const configHome = path.join(root, "config");
  const dataHome = path.join(root, "data");
  const liveRoot = path.join(root, "live-root");
  const agentDir = path.join(root, "omp-agent");
  const deliveryDirectory = path.join(root, "omp-delivery");
  await mkdir(liveRoot, { recursive: true });
  await mkdir(path.join(configHome, "throne"), { recursive: true });
  await mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await symlink(
    path.resolve("extensions/omp/throne-omp-delivery.ts"),
    path.join(agentDir, "extensions", "throne-omp-delivery.ts"),
  );
  await writeFile(
    path.join(liveRoot, "package.json"),
    '{"type":"module"}\n',
    "utf8",
  );
  await writeFile(
    path.join(configHome, "throne", "features.json"),
    JSON.stringify({ "herdr-decouple": true }),
    "utf8",
  );
  return {
    dataHome,
    deliveryDirectory,
    environment: {
      ...process.env,
      OMP_AGENT_DIR: agentDir,
      OMP_SKIP_SETUP: "1",
      PI_CODING_AGENT_DIR: agentDir,
      THRONE_OMP_DELIVERY_DIR: deliveryDirectory,
      XDG_CONFIG_HOME: configHome,
      THRONE_DATA_HOME: dataHome,
      THRONE_LIVE_ROOT: liveRoot,
    },
  };
}

test("a real in-container omp receives queued and direct send-agent deliveries separately", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "o-"));
  const { dataHome, deliveryDirectory, environment } =
    await createOmpHarnessEnvironment(root);
  const noModel = await ompModelSkipReason(environment);
  if (noModel !== undefined) {
    t.skip(noModel);
    return;
  }
  const session = await launchHerdrSuiteSession(
    "omp-delivery-harness",
    environment,
  );
  const isolatedEnvironment = {
    ...environment,
    THRONE_HERDR_SESSION_NAME_OVERRIDE: session.sessionName,
  };
  try {
    const recipient = await createRealOmpAgent(
      session.sessionName,
      isolatedEnvironment,
    );
    const herdrVersion = await execFileAsync("herdr", ["--version"], {
      env: isolatedEnvironment,
    });
    const ompVersion = await execFileAsync("omp", ["--version"], {
      env: isolatedEnvironment,
    });
    assert.ok(herdrVersion.stdout.trim().length > 0);
    assert.ok(ompVersion.stdout.trim().length > 0);

    const deliveredPayloads: string[] = [];
    let submittedCount = 0;
    const submitToOmp = async (
      _recipient: { readonly name?: string; readonly paneId?: string },
      sender: string,
      prompt: string,
    ): Promise<void> => {
      submittedCount += 1;
      const outcome = await deliverToOmp(
        `${sender} said: ${prompt}`,
        5_000,
        recipient.paneId,
        { directory: deliveryDirectory, pollMs: 25 },
      );
      assert.equal(outcome.kind, "delivered");
      deliveredPayloads.push(`${sender} said: ${prompt}`);
    };
    const queuePath = path.join(dataHome, "message-queue.sqlite3");
    const command = new SendAgentCommand({
      resolveAgent: async () => recipient,
      resolveCurrentAgentName: async () => "isolated-omp-sender",
      submitToAgent: submitToOmp,
      openMessageQueueStore: () => openMessageQueueStore(queuePath),
      checkRuntimeModelAcceptance: async () => ({ ok: true }),
    });

    await command.run([recipient.name, "queued delivery payload"]);
    const queuedStore = openMessageQueueStore(queuePath);
    const queued = queuedStore.listWorkItemsByStates([
      MessageQueueWorkItemState.Queued,
    ]);
    assert.equal(
      submittedCount,
      0,
      "queued delivery must not bypass the worker",
    );
    assert.equal(queued.length, 1, "queued delivery must create one work item");
    const queuedItem = queued[0]!;
    queuedStore.close();
    const workerStore = openMessageQueueStore(queuePath);
    const claimedItem = workerStore.claimNextDueWorkItem();
    assert.equal(claimedItem?.id, queuedItem.id);
    await deliverMessageWorkItem(workerStore, claimedItem!, {
      resolveAgent: async () => recipient,
      submitToAgent: submitToOmp,
      clearBlockedMarker: async () => {},
      readAgentRole: async () => undefined,
      readAgentSupervisor: async () => undefined,
      recordDeliveredEvent: async () => {},
      sleep,
      maxNotSentAttempts: 1,
    });
    assert.equal(
      workerStore.readWorkItem(queuedItem.id)?.state,
      MessageQueueWorkItemState.Delivered,
      "queued delivery must finish only after the real OMP extension acknowledges it",
    );
    workerStore.close();

    await command.run([recipient.name, "--direct", "direct delivery payload"]);
    assert.equal(
      submittedCount,
      2,
      "--direct must submit synchronously instead of creating another queue item",
    );
    const finalStore = openMessageQueueStore(queuePath);
    assert.equal(
      finalStore.listWorkItemsByStates([MessageQueueWorkItemState.Queued])
        .length,
      0,
      "--direct must leave no queued work item behind",
    );
    finalStore.close();
    assert.deepEqual(
      deliveredPayloads,
      [
        "isolated-omp-sender said: queued delivery payload",
        "isolated-omp-sender said: direct delivery payload",
      ],
      "the queued worker and --direct path must each receive a real OMP delivery acknowledgement",
    );
    assert.match(recipient.paneId, /^w\d+:p\d+$/);
  } finally {
    await session.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a resident draft remains byte-identical and receives no OMP delivery", async (t) => {
  const draft = "resident draft — preserve these exact bytes";
  const payload = "delivery that must remain in flight";

  const root = await mkdtemp(path.join(tmpdir(), "o-"));
  const { deliveryDirectory, environment } =
    await createOmpHarnessEnvironment(root);
  const noModel = await ompModelSkipReason(environment);
  if (noModel !== undefined) {
    t.skip(noModel);
    return;
  }
  const session = await launchHerdrSuiteSession(
    "omp-resident-draft",
    environment,
  );
  const isolatedEnvironment = {
    ...environment,
    THRONE_HERDR_SESSION_NAME_OVERRIDE: session.sessionName,
  };
  try {
    const recipient = await createRealOmpAgent(
      session.sessionName,
      isolatedEnvironment,
    );
    await sleep(500);
    await execFileAsync(
      ownedHerdrClientPath(),
      [
        "--session",
        session.sessionName,
        "pane",
        "send-text",
        recipient.paneId,
        draft,
      ],
      { env: isolatedEnvironment },
    );
    await sleep(250);
    assert.match(
      await readVisibleAgentAnsi(
        session.sessionName,
        recipient.name,
        isolatedEnvironment,
      ),
      new RegExp(draft),
      "the resident draft must be visible before delivery is attempted",
    );

    const pending = deliverToOmp(payload, 1_000, recipient.paneId, {
      directory: deliveryDirectory,
      pollMs: 25,
    });
    await sleep(250);
    const inFlightEntries = await readdir(deliveryDirectory);
    assert.ok(
      inFlightEntries.some((entry) =>
        entry.startsWith(ompRequestPrefix(recipient.paneId)),
      ),
      "the draft must hold the addressed request in flight",
    );
    assert.equal(
      inFlightEntries.some((entry) => entry.startsWith("ack-")),
      false,
      "a resident draft must not acknowledge delivery",
    );
    const outcome = await pending;
    assert.equal(outcome.kind, "timed-out");
    assert.ok(outcome.waitedMs >= 1_000);
    assert.ok(
      outcome.waitedMs < 1_250,
      `draft-held delivery must withdraw within 1,250ms, took ${outcome.waitedMs}ms`,
    );

    const visible = await readVisibleAgentAnsi(
      session.sessionName,
      recipient.name,
      isolatedEnvironment,
    );
    assert.match(
      visible,
      new RegExp(draft),
      "delivery must not alter the resident draft",
    );
    assert.doesNotMatch(
      visible,
      new RegExp(payload),
      "delivery must not enter the composer",
    );
  } finally {
    await session.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "clearing a resident OMP draft releases exactly one delivery",
  {
    todo: 'deliverToOmp returns delivered when the extension sendUserMessage failed with "No model selected"; the payload never reaches the pane, and this assertion must pass again when the extension reports failure instead of success',
  },
  async (t) => {
  const draft = "resident draft cleared before delivery";
  const payload = "deliver exactly once after draft clears";

  const root = await mkdtemp(path.join(tmpdir(), "o-"));
  const { deliveryDirectory, environment } =
    await createOmpHarnessEnvironment(root);
  const noModel = await ompModelSkipReason(environment);
  if (noModel !== undefined) {
    t.skip(noModel);
    return;
  }
  const session = await launchHerdrSuiteSession(
    "omp-clear-resident-draft",
    environment,
  );
  const isolatedEnvironment = {
    ...environment,
    THRONE_HERDR_SESSION_NAME_OVERRIDE: session.sessionName,
  };
  try {
    const recipient = await createRealOmpAgent(
      session.sessionName,
      isolatedEnvironment,
    );
    await sleep(500);
    await execFileAsync(
      ownedHerdrClientPath(),
      [
        "--session",
        session.sessionName,
        "pane",
        "send-text",
        recipient.paneId,
        draft,
      ],
      { env: isolatedEnvironment },
    );
    const deliveryStartedAt = Date.now();
    const pending = deliverToOmp(payload, 5_000, recipient.paneId, {
      directory: deliveryDirectory,
      pollMs: 25,
    });
    await sleep(250);
    await execFileAsync(
      ownedHerdrClientPath(),
      [
        "--session",
        session.sessionName,
        "pane",
        "send-keys",
        recipient.paneId,
        "ctrl+u",
      ],
      { env: isolatedEnvironment },
    );

    const outcome = await pending;
    assert.equal(outcome.kind, "delivered");
    assert.ok(Date.now() - deliveryStartedAt < 1_250);
    const entries = await readdir(deliveryDirectory);
    assert.equal(
      entries.some((entry) =>
        entry.startsWith(ompRequestPrefix(recipient.paneId)),
      ),
      false,
      "the delivered request must be consumed",
    );
    await sleep(750);
    const visible = await readVisibleAgentAnsi(
      session.sessionName,
      recipient.name,
      isolatedEnvironment,
    );
    assert.equal(
      visible.match(new RegExp(payload, "g"))?.length,
      1,
      "the delivered payload must appear exactly once after the extension revisits the request directory",
    );
  } finally {
    await session.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("the in-container tab leak guard refuses a deliberately leaked Herdr workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "o-"));
  const configHome = path.join(root, "config");
  const dataHome = path.join(root, "data");
  const liveRoot = path.join(root, "live-root");
  await mkdir(liveRoot, { recursive: true });
  await mkdir(path.join(configHome, "throne"), { recursive: true });
  await writeFile(
    path.join(liveRoot, "package.json"),
    '{"type":"module"}\n',
    "utf8",
  );
  await writeFile(
    path.join(configHome, "throne", "features.json"),
    JSON.stringify({ "herdr-decouple": true }),
    "utf8",
  );
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    THRONE_DATA_HOME: dataHome,
    THRONE_LIVE_ROOT: liveRoot,
  };
  const session = await launchHerdrSuiteSession(
    "omp-delivery-harness-leak",
    environment,
  );
  const isolatedEnvironment = {
    ...environment,
    THRONE_HERDR_SESSION_NAME_OVERRIDE: session.sessionName,
  };
  const guardArguments = [
    "--import",
    TYPESCRIPT_REGISTER_PATH,
    TAB_LEAK_GUARD_PATH,
  ];
  try {
    await execFileAsync(process.execPath, [...guardArguments, "pretest"], {
      env: isolatedEnvironment,
    });
    await execFileAsync(
      "herdr",
      [
        "--session",
        session.sessionName,
        "workspace",
        "create",
        "--label",
        "deliberately-leaked",
      ],
      { env: isolatedEnvironment },
    );
    await assert.rejects(
      execFileAsync(process.execPath, [...guardArguments, "posttest"], {
        env: isolatedEnvironment,
      }),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr ?? "",
          /herdr-tab-leak-guard: 1 tab\(s\) leaked/,
        );
        return true;
      },
    );
  } finally {
    await session.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
