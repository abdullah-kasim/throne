import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { HARNESS_NAMES } from "../src/harness-routing/harness.ts";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";
import { fakeClaudeAgent, fakeVirtualClock } from "../src/herdr/herdr-send-test-fixtures.ts";
import { SOCKET_STARTUP_WAIT_MS, submitToAgentWhileLocked } from "../src/herdr/herdr-send-transaction.ts";
import { probeComposerCleared, submitToAgentUnkeyed } from "../src/herdr/herdr-send-unkeyed.ts";
import { submittedPayload } from "../src/herdr/herdr-send.helpers.ts";
import type { SubmitToAgentDeps } from "../src/herdr/herdr-send.types.ts";
import { deliverThroughExtension, type ExtensionDeliveryOutcome } from "../src/herdr/delivery-request-client.ts";
import { SubmitAssumedFilledError, SubmitNotSentError } from "../src/herdr/herdr-send.types.ts";
import { agentAlive } from "../src/herdr/delivery-request-client.ts";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REAL_CLAUDE_MOD_DELIVERY_DEPS } from "../src/herdr/claude-mod-route.ts";
import { createStubRecipient } from "./stub-recipient.ts";
import { claudeComposerLine, claudeScreen, DIM_HINT, WHITE } from "./claude-screens.ts";

const EMPTY_COMPOSER_SCREEN = claudeScreen(claudeComposerLine(DIM_HINT));

interface Recipient {
  readonly showDraft: (text: string) => void;
  readonly deps: SubmitToAgentDeps;
  readonly textsTyped: string[];
  readonly modRequests: string[];
  readonly logLines: string[];
  readonly modAsked: string[];
  readonly screenReads: string[];
  readonly keysPressed: string[];
}

function recipient(
  agent: HerdrAgent,
  usesMod: boolean,
  modAnswer: ExtensionDeliveryOutcome,
  answering: boolean | (() => boolean) = true,
): Recipient {
  let screen = EMPTY_COMPOSER_SCREEN;
  const textsTyped: string[] = [];
  const modRequests: string[] = [];
  const logLines: string[] = [];
  const modAsked: string[] = [];
  const screenReads: string[] = [];
  const keysPressed: string[] = [];
  const readScreen = async (target: string): Promise<string> => {
    screenReads.push(target);
    return screen;
  };
  const deps = {
    ...fakeVirtualClock(),
    getPaneProcessInfo: async () => ({
      paneId: agent.paneId,
      foregroundProcesses: [{ name: agent.agent, argv: [agent.agent] }],
    }),
    readVisibleAgentAnsi: readScreen,
    readRecentAgentAnsi: readScreen,
    pressPaneKey: async (_pane: string, key: string) => {
      keysPressed.push(key);
    },
    withRecipientPaneLock: async <T>(_pane: string, action: () => Promise<T>) => action(),
    refreshRecipientIdentity: async () => agent,
    sendText: async (_pane: string, text: string) => {
      textsTyped.push(text);
      screen = claudeScreen(claudeComposerLine(`${WHITE}${text}`));
    },
    pressEnter: async () => {
      keysPressed.push("Enter");
      screen = EMPTY_COMPOSER_SCREEN;
    },
    deliverThroughExtension: async (text: string) => {
      modRequests.push(text);
      return modAnswer;
    },
    claudeMod: {
      usesMod: async (name: string) => {
        modAsked.push(name);
        return usesMod;
      },
      socketOf: async () => "/socket",
      alive: async (_socket: string | undefined, paneId: string) =>
        (typeof answering === "function" ? answering() : answering)
          ? { pane: paneId, harness: "claude" as const, commands: false }
          : undefined,
      log: (line: string) => logLines.push(line),
    },
  } as SubmitToAgentDeps;
  return {
    deps,
    textsTyped,
    modRequests,
    logLines,
    modAsked,
    screenReads,
    keysPressed,
    showDraft: (text: string) => {
      screen = claudeScreen(claudeComposerLine(`${WHITE}${text}`));
    },
  };
}

test("a Claude agent launched with the mod takes the message through the mod and no key is typed into its pane", async () => {
  const pane = recipient(fakeClaudeAgent(), true, { kind: "delivered" });
  const delivered = await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", {}, pane.deps);
  assert.equal(pane.modRequests.length, 1);
  assert.equal(delivered, pane.modRequests[0]);
  assert.deepEqual(pane.textsTyped, []);
  assert.deepEqual(pane.logLines, []);
});

test("the mod path carries the same sender and number wrapper the typed path produces", async () => {
  const options = { messageId: 7 };
  const pane = recipient(fakeClaudeAgent(), true, { kind: "delivered" });
  const viaMod = await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", options, pane.deps);
  assert.equal(viaMod, submittedPayload("alpha", "hello", options));
  assert.match(viaMod!, /alpha said: hello/u);
  assert.match(viaMod!, /7/u);
});

test("a Claude agent with no recorded mod takes typed keys exactly as before", async () => {
  const pane = recipient(fakeClaudeAgent(), false, { kind: "delivered" });
  await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", {}, pane.deps);
  assert.deepEqual(pane.modRequests, []);
  assert.equal(pane.textsTyped.length, 1);
  assert.deepEqual(pane.logLines, []);
});

test("a message the Claude mod may still submit is never also typed", async () => {
  const agent = fakeClaudeAgent();
  const pane = recipient(agent, true, { kind: "timed-out", waitedMs: 900 });
  await assert.rejects(
    submitToAgentWhileLocked(agent, "alpha", "hello", {}, pane.deps),
    (error: Error) => error instanceof SubmitNotSentError,
  );
  assert.equal(pane.modRequests.length, 1);
  assert.deepEqual(pane.textsTyped, []);
  assert.deepEqual(pane.keysPressed, []);
});

test("a mod that stops answering has its connection closed, the message goes by typed keys exactly once, and one line names the agent and the reason", async () => {
  const agent = fakeClaudeAgent();
  const pane = recipient(agent, true, { kind: "timed-out", waitedMs: 900 });
  let signChecks = 0;
  pane.deps.claudeMod!.alive = async (_socket, paneId) =>
    (signChecks += 1) === 1 ? { pane: paneId, harness: "claude", commands: false } : undefined;
  await submitToAgentWhileLocked(agent, "alpha", "hello", {}, pane.deps);
  assert.equal(pane.modRequests.length, 1);
  assert.equal(pane.textsTyped.length, 1);
  assert.equal(pane.logLines.length, 1);
  assert.match(pane.logLines[0]!, new RegExp(`"${agent.name}".*no answer after 900ms.*typed keys`, "u"));
});

test("a message whose connection drops after it was sent is assumed filled and never also typed", async () => {
  const agent = fakeClaudeAgent();
  const socketPath = path.join(mkdtempSync(path.join(os.tmpdir(), "dropped-")), "s.sock");
  const server = createServer((incoming, outgoing) => {
    if (incoming.url === "/alive") {
      outgoing.end(JSON.stringify({ pane: agent.paneId, harness: "claude", commands: false }));
      return;
    }
    incoming.on("data", () => undefined);
    incoming.on("end", () => incoming.socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const pane = recipient(agent, true, { kind: "delivered" });
    pane.deps.deliverThroughExtension = (text, timeoutMs, paneId) => deliverThroughExtension(text, timeoutMs, paneId, { socketPath });
    pane.deps.claudeMod!.socketOf = async () => socketPath;
    pane.deps.claudeMod!.alive = agentAlive;
    await assert.rejects(
      submitToAgentWhileLocked(agent, "alpha", "hello", { composerWaitMilliseconds: 5_000 }, pane.deps),
      (error: Error) => error instanceof SubmitAssumedFilledError,
    );
    assert.deepEqual(pane.textsTyped, []);
    assert.deepEqual(pane.keysPressed, []);
    assert.deepEqual(pane.logLines, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a mod that refuses the request falls back to typed keys once and names the refusal", async () => {
  const pane = recipient(fakeClaudeAgent(), true, { kind: "refused", detail: "pane mismatch" });
  await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", {}, pane.deps);
  assert.equal(pane.textsTyped.length, 1);
  assert.equal(pane.logLines.length, 1);
  assert.match(pane.logLines[0]!, /pane mismatch/u);
});

test("Codex agents are messaged exactly as before", async () => {
  const codex = { ...fakeClaudeAgent(), agent: HARNESS_NAMES.CODEX };
  const pane = recipient(codex, true, { kind: "delivered" });
  await submitToAgentWhileLocked(codex, "alpha", "hello", {}, pane.deps).catch(() => undefined);
  assert.deepEqual(pane.modAsked, []);
  assert.deepEqual(pane.modRequests, []);
});

test("send to a Claude agent with the mod reads no pane and presses no key, even with a human draft in its composer", async () => {
  const agent = fakeClaudeAgent();
  const pane = recipient(agent, true, { kind: "delivered" });
  pane.showDraft("half typed by the person");
  await submitToAgentUnkeyed(agent, "alpha", "hello", { composerWaitMilliseconds: 1_000 }, pane.deps);
  assert.equal(pane.modRequests.length, 1);
  assert.deepEqual(pane.screenReads, []);
  assert.deepEqual(pane.keysPressed, []);
  assert.deepEqual(pane.textsTyped, []);
});

test("the queue lets a message through to a Claude agent with the mod without reading its pane, even with a human draft in its composer", async () => {
  const agent = fakeClaudeAgent();
  const pane = recipient(agent, true, { kind: "delivered" });
  pane.showDraft("half typed by the person");
  assert.equal(await probeComposerCleared(agent, {}, pane.deps), true);
  assert.deepEqual(pane.screenReads, []);
});

test("a Claude agent whose mod stopped answering gets the message by typed keys within seconds and one line names it", async () => {
  const agent = fakeClaudeAgent();
  const pane = recipient(agent, true, { kind: "delivered" }, false);
  const clock = pane.deps.now();
  await submitToAgentWhileLocked(agent, "alpha", "hello", {}, pane.deps);
  assert.deepEqual(pane.modRequests, []);
  assert.equal(pane.textsTyped.length, 1);
  assert.equal(pane.logLines.length, 1);
  assert.match(pane.logLines[0]!, new RegExp(`"${agent.name}".*not answering.*typed keys`, "u"));
  assert.ok(pane.deps.now() - clock < 10_000);
});

test("the mod counts as answering only while its own pane's socket answers", async () => {
  const recipient = await createStubRecipient({ pane: "w1:p2" });
  try {
    assert.notEqual(await REAL_CLAUDE_MOD_DELIVERY_DEPS.alive(recipient.socketPath, "w1:p2"), undefined);
    assert.equal(await REAL_CLAUDE_MOD_DELIVERY_DEPS.alive(recipient.socketPath, "w1:p9"), undefined);
    await recipient.stopListening();
    assert.equal(await REAL_CLAUDE_MOD_DELIVERY_DEPS.alive(recipient.socketPath, "w1:p2"), undefined);
  } finally {
    await recipient.dispose();
  }
});

test("a message queued behind a person's draft waits on the open connection until the draft is submitted and then arrives", async () => {
  const agent = fakeClaudeAgent();
  const modPane = await createStubRecipient({ pane: agent.paneId, state: { kind: "resident-draft", text: "half typed by the person" } });
  const pane = recipient(agent, true, { kind: "delivered" });
  pane.showDraft("half typed by the person");
  const panesLocked: string[] = [];
  const deps: SubmitToAgentDeps = {
    ...pane.deps,
    claudeMod: { ...pane.deps.claudeMod!, socketOf: async () => modPane.socketPath },
    withRecipientPaneLock: async <T>(paneId: string, action: () => Promise<T>) => {
      panesLocked.push(paneId);
      return action();
    },
    deliverThroughExtension,
  };
  try {
    const sends = [3, 1, 2].map((messageId) =>
      submitToAgentUnkeyed(agent, "alpha", `message ${messageId}`, { messageId, composerWaitMilliseconds: 8_000 }, deps),
    );
    while (modPane.requests.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(modPane.submitted, []);
    assert.deepEqual(panesLocked, []);
    assert.deepEqual(pane.keysPressed, []);
    assert.deepEqual(pane.textsTyped, []);
    modPane.setState({ kind: "acknowledge" });
    const delivered = await Promise.all(sends);
    assert.deepEqual(modPane.submitted.map((request) => request.id).sort(), ["message-1", "message-2", "message-3"]);
    assert.deepEqual(delivered.map((text) => text?.match(/message (\d)/u)?.[1]), ["3", "1", "2"]);
  } finally {
    await modPane.dispose();
  }
});

test("delivery goes by the mod for a launch that recorded it and by typed keys for one that did not, with nothing to switch on", async () => {
  const dataHome = mkdtempSync(path.join(os.tmpdir(), "claude-mod-recorded-"));
  const court = `
    import { REAL_CLAUDE_MOD_DELIVERY_DEPS, decideClaudeModLaunch, recordClaudeModInSpawn } from "./src/herdr/claude-mod-route.ts";
    import { writeSpawnSpec } from "./src/agentdata/spawn-data-contracts.ts";
    const home = process.env.THRONE_DATA_HOME;
    const launches = { fits: () => undefined, misfits: () => "claude plugin validate failed: unknown hook" };
    const usesMod = {};
    for (const [name, misfit] of Object.entries(launches)) {
      await writeSpawnSpec(name, { harness: "claude", model: "opus", effort: 1, cwd: home, spawned_at: "2026-11-18T00:00:00.000Z" });
      await recordClaudeModInSpawn(name, decideClaudeModLaunch(misfit).load);
      usesMod[name] = await REAL_CLAUDE_MOD_DELIVERY_DEPS.usesMod(name);
    }
    console.log(JSON.stringify(usesMod));
  `;
  const result = spawnSync(process.execPath, ["-e", court], {
    cwd: path.join(import.meta.dirname, ".."),
    env: { ...process.env, THRONE_DATA_HOME: dataHome, THRONE_LIVE_ROOT: dataHome },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const usesMod = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  assert.deepEqual(usesMod, { fits: true, misfits: false });
  const typedWithoutMod = recipient(fakeClaudeAgent(), usesMod.misfits, { kind: "delivered" });
  await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", {}, typedWithoutMod.deps);
  assert.deepEqual(typedWithoutMod.modRequests, []);
  assert.equal(typedWithoutMod.textsTyped.length, 1);
  const byMod = recipient(fakeClaudeAgent(), usesMod.fits, { kind: "delivered" });
  await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", {}, byMod.deps);
  assert.equal(byMod.modRequests.length, 1);
  assert.deepEqual(byMod.textsTyped, []);
});

test("an opening prompt whose mod answers after three polls goes through the mod with no fallback line", async () => {
  let polls = 0;
  const pane = recipient(fakeClaudeAgent(), true, { kind: "delivered" }, () => {
    polls += 1;
    return polls > 3;
  });
  await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", { waitForStartupQuiescence: true }, pane.deps);
  assert.equal(pane.modRequests.length, 1);
  assert.deepEqual(pane.textsTyped, []);
  assert.deepEqual(pane.logLines, []);
});

test("an opening prompt whose mod never answers is typed once after the limit with one fallback line", async () => {
  const pane = recipient(fakeClaudeAgent(), true, { kind: "delivered" }, false);
  const startedAt = pane.deps.now();
  await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", { waitForStartupQuiescence: true }, pane.deps);
  assert.ok(pane.deps.now() - startedAt >= SOCKET_STARTUP_WAIT_MS);
  assert.deepEqual(pane.modRequests, []);
  assert.equal(pane.textsTyped.length, 1);
  assert.equal(pane.logLines.length, 1);
});

test("a message that is not an opening prompt to a silent mod is typed at once", async () => {
  const pane = recipient(fakeClaudeAgent(), true, { kind: "delivered" }, false);
  const startedAt = pane.deps.now();
  await submitToAgentWhileLocked(fakeClaudeAgent(), "alpha", "hello", {}, pane.deps);
  assert.ok(pane.deps.now() - startedAt < SOCKET_STARTUP_WAIT_MS);
  assert.equal(pane.textsTyped.length, 1);
  assert.equal(pane.logLines.length, 1);
});
