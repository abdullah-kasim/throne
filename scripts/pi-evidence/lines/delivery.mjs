import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PIY_PATH, STAND_IN_KEY, THRONE_ROOT, pause, piEntryPath, pollUntil } from "../support.mjs";
import { buildLaunchArgv } from "../../../src/harness-routing/harness.ts";
import { agentAlive } from "../../../src/herdr/delivery-request-client.ts";
import { DELIVERY_SOCKET_ENV } from "../../../extensions/shared/agent-delivery-contract.ts";
import { openMessageQueueStore } from "../../../src/message-queue/message-queue.store.ts";
import { enqueueMessageDelivery } from "../../../src/send-agent/message-delivery-enqueue.ts";
import { installPiDeliveryExtension, piDeliveryExtensionSource } from "../../../src/herdr/pi-extension-install.ts";
import { writeStandInAgentDirectory } from "../../../test/support/pi-provider-stand-in/pi-provider-stand-in.mjs";

const HERDR_PI_INTEGRATION = path.join(os.homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
const SLOW_TURN_WORD = "SLOW-TURN";
const SLOW_TURN_MILLISECONDS = 6_000;
const HUMAN_DRAFT = "human draft xyz";
const DRAFT_HOLD_WINDOW_MILLISECONDS = 5_000;

function userTexts(body) {
  return (body.messages ?? []).filter((message) => message.role === "user").map((message) =>
    typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join(""),
  );
}

function recordingStandIn(workspace) {
  const turns = [];
  return workspace.standIn({
    async plannedReply(body) {
      const texts = userTexts(body);
      const latest = texts[texts.length - 1] ?? "";
      const turn = { texts, latest, startedAt: Date.now(), endedAt: undefined };
      turns.push(turn);
      if (latest.includes(SLOW_TURN_WORD)) await pause(SLOW_TURN_MILLISECONDS);
      turn.endedAt = Date.now();
      return { text: `answered ${latest.split(/\s+/).find((word) => word.startsWith("MSG-")) ?? "draft"}` };
    },
  }).then((server) => Object.assign(server, { turns }));
}

function occurrences(server, marker) {
  const last = server.turns[server.turns.length - 1];
  return last === undefined ? 0 : last.texts.filter((text) => text.includes(marker)).length;
}

async function waitFor(check, timeoutMilliseconds = 60_000) {
  const polled = await pollUntil(check, Boolean, timeoutMilliseconds, 300);
  return polled.found ? polled.value : undefined;
}

async function typeDraft(room, paneId) {
  await room.herdr.call("pane", "send-text", paneId, HUMAN_DRAFT);
  const shown = await room.herdr.waitForPaneText(paneId, (text) => text.includes(HUMAN_DRAFT), 15_000);
  if (!shown.found) throw new Error("the human draft never showed in the pane");
}

export async function court(workspace) {
  const herdr = await workspace.herdr();
  const socketFolder = await mkdtemp(path.join(os.tmpdir(), "pis-"));
  const refusalLog = path.join(workspace.lineDirectory, "herdr-refusals.log");
  await writeFile(refusalLog, "");
  const databasePath = path.join(workspace.dataHome, "message-queue.sqlite3");
  const store = openMessageQueueStore(databasePath);
  const sockets = {};
  let backend;
  let backendOutput = "";

  const state = {
    herdr,
    sockets,
    async startAgent(name, { withExtension = true } = {}) {
      const standIn = await recordingStandIn(workspace);
      const ledger = path.join(workspace.dataHome, "data", name);
      const agentDirectory = path.join(ledger, "pi-agent");
      sockets[name] = path.join(socketFolder, `${name}.sock`);
      await writeStandInAgentDirectory(agentDirectory, standIn.baseUrl, writeFile, mkdir);
      await mkdir(path.join(agentDirectory, "extensions"), { recursive: true });
      if (withExtension) await installPiDeliveryExtension(agentDirectory, piDeliveryExtensionSource(THRONE_ROOT));
      await copyFile(HERDR_PI_INTEGRATION, path.join(agentDirectory, "extensions", "herdr-agent-state.ts")).catch(() => undefined);
      const paneId = await herdr.openPane(workspace.repository);
      const argv = buildLaunchArgv({
        harness: "pi",
        model: "flash",
        effort: 3,
        piSession: { sessionId: randomUUID(), sessionDirectory: path.join(ledger, "pi-sessions") },
      });
      argv[0] = PIY_PATH;
      await herdr.runPi(paneId, workspace.piLaunchCommand(argv, {
        DEEPSEEK_API_KEY: STAND_IN_KEY,
        PI_OFFLINE: "1",
        PI_BIN: piEntryPath(),
        PI_CODING_AGENT_DIR: agentDirectory,
        THRONE_DATA_HOME: workspace.dataHome,
        [DELIVERY_SOCKET_ENV]: sockets[name],
      }));
      const ready = await herdr.waitForPi(paneId, "deepseek-flash");
      if (!ready.found) throw new Error(`pi never started in ${paneId}: ${ready.cause}`);
      const renamed = await waitFor(async () => {
        try {
          await herdr.call("agent", "rename", paneId, name);
          return true;
        } catch {
          return false;
        }
      }, 30_000);
      if (renamed !== true) throw new Error(`herdr never saw pi as an agent in ${paneId}`);
      await pause(1500);
      return { name, paneId, standIn };
    },
    async adoptLaunchedAgent(name, paneId, standIn) {
      sockets[name] = JSON.parse(await readFile(path.join(workspace.dataHome, "data", name, "spawn.json"), "utf8")).delivery_socket;
      return { name, paneId, standIn };
    },
    async answering(agent) {
      return (await agentAlive(sockets[agent.name], agent.paneId)) !== undefined;
    },
    async startBackend({ typing = false } = {}) {
      backend = spawn(process.execPath, [
        path.join(THRONE_ROOT, "scripts", "pi-evidence", "delivery-backend.mjs"),
        JSON.stringify({ databasePath, sessionName: herdr.sessionName, sockets, refusalLog, waitMilliseconds: 60_000, typing }),
      ], { env: workspace.throneEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      backend.stdout.on("data", (part) => (backendOutput += part));
      backend.stderr.on("data", (part) => (backendOutput += part));
      const ready = await waitFor(() => backendOutput.includes("backend ready") || backend.exitCode !== null, 30_000);
      if (ready !== true || !backendOutput.includes("backend ready")) throw new Error(`the delivery backend did not start: ${backendOutput}`);
    },
    async killBackend() {
      const exited = new Promise((resolve) => backend.once("exit", resolve));
      backend.kill("SIGKILL");
      await exited;
    },
    send(agent, prompt) {
      return enqueueMessageDelivery(store, {
        recipientName: agent.name,
        recipientPaneId: agent.paneId,
        senderName: "pi-evidence",
        prompt,
        clearRecipientBlockedOnDelivery: false,
      }).id;
    },
    stateOf(id) {
      return store.readWorkItem(id);
    },
    waitForFinished(id, timeoutMilliseconds) {
      return waitFor(() => {
        const row = store.readWorkItem(id);
        return row !== undefined && row.state !== "queued" && row.state !== "in-flight" ? row : undefined;
      }, timeoutMilliseconds);
    },
    backendOutput() {
      return backendOutput;
    },
    async refusals() {
      return (await readFile(refusalLog, "utf8")).trim();
    },
    async messageStatus(id) {
      const result = await workspace.throneCli(["message-status", "--local", String(id)]);
      await workspace.saveText(`message-status-${id}.txt`, `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
      return result.stdout + result.stderr;
    },
    async finish(agents) {
      await workspace.saveText("backend-output.txt", backendOutput);
      for (const agent of agents) {
        await herdr.savePane(agent.paneId, `pane-${agent.name}.txt`);
        await workspace.saveText(`provider-turns-${agent.name}.json`, `${JSON.stringify(agent.standIn.turns, null, 2)}\n`);
      }
      backend?.kill("SIGKILL");
      store.close?.();
    },
  };
  return state;
}

function marker() {
  return `MSG-${randomUUID().slice(0, 8)}`;
}

function verdict(passed, observed) {
  return { verdict: passed ? "PASS" : "FAIL", observed };
}

async function idleAgentAnswersATurn(workspace) {
  const room = await court(workspace);
  const agent = await room.startAgent("shadow-pievidence-a");
  await room.startBackend();
  const word = marker();
  const id = room.send(agent, `please answer ${word}`);
  const row = await room.waitForFinished(id);
  const answered = await waitFor(() => occurrences(agent.standIn, word) === 1);
  const status = await room.messageStatus(id);
  const refusals = await room.refusals();
  await room.finish([agent]);
  return verdict(
    row?.state === "delivered" && answered === true && /delivered/.test(status) && refusals === "",
    `queue state ${row?.state}; turn reached the provider: ${answered === true}; message-status: ${status.trim().split("\n")[0]}; refused herdr calls: ${refusals === "" ? "none" : refusals}`,
  );
}

async function draftWaitsAndStaysIntact(workspace) {
  const room = await court(workspace);
  const agent = await room.startAgent("shadow-pievidence-a");
  await room.startBackend();
  await typeDraft(room, agent.paneId);
  const word = marker();
  const id = room.send(agent, `please answer ${word}`);
  await pause(DRAFT_HOLD_WINDOW_MILLISECONDS);
  const heldState = room.stateOf(id)?.state;
  const reachedEarly = agent.standIn.turns.some((turn) => turn.latest.includes(word));
  const paneWhileHeld = await room.herdr.savePane(agent.paneId, "pane-while-held.txt");
  const draftIntact = paneWhileHeld.includes(HUMAN_DRAFT);
  await room.herdr.call("pane", "send-keys", agent.paneId, "Enter");
  const row = await room.waitForFinished(id);
  await waitFor(() => occurrences(agent.standIn, word) === 1);
  const draftTurn = (await waitFor(() => agent.standIn.turns.some((turn) => turn.latest === HUMAN_DRAFT), 15_000)) === true;
  const once = occurrences(agent.standIn, word);
  const refusals = await room.refusals();
  await room.finish([agent]);
  return verdict(
    heldState === "in-flight" && !reachedEarly && draftIntact && draftTurn && row?.state === "delivered" && once === 1 && refusals === "",
    `while the draft sat: queue state ${heldState}, message reached the provider: ${reachedEarly}, draft on screen: ${draftIntact}; after Enter the draft was its own turn exactly "${HUMAN_DRAFT}": ${draftTurn}; queue state ${row?.state}; message count in the conversation: ${once}; refused herdr calls: ${refusals === "" ? "none" : refusals}`,
  );
}

async function midTurnMessageWaitsForTheTurn(workspace) {
  const room = await court(workspace);
  const agent = await room.startAgent("shadow-pievidence-a");
  await room.startBackend();
  const slow = marker();
  const next = marker();
  const slowId = room.send(agent, `${SLOW_TURN_WORD} ${slow}`);
  await waitFor(() => agent.standIn.turns.some((turn) => turn.latest.includes(slow)));
  await pause(1500);
  const nextId = room.send(agent, `please answer ${next}`);
  const nextRow = await room.waitForFinished(nextId);
  await waitFor(() => agent.standIn.turns.some((turn) => turn.latest.includes(next)));
  const slowTurn = agent.standIn.turns.find((turn) => turn.latest.includes(slow));
  const nextTurn = agent.standIn.turns.find((turn) => turn.latest.includes(next));
  const slowFinished = slowTurn?.endedAt !== undefined;
  const afterwards = nextTurn !== undefined && slowTurn?.endedAt !== undefined && nextTurn.startedAt >= slowTurn.endedAt;
  const pane = await room.herdr.savePane(agent.paneId, "pane-after-both.txt");
  const slowAnswerShown = pane.includes(`answered ${slow}`);
  const refusals = await room.refusals();
  const slowState = room.stateOf(slowId)?.state;
  await room.finish([agent]);
  return verdict(
    slowState === "delivered" && nextRow?.state === "delivered" && slowFinished && afterwards && slowAnswerShown && refusals === "",
    `slow turn finished: ${slowFinished}, its answer shown: ${slowAnswerShown}; next message started ${nextTurn === undefined ? "never" : `${nextTurn.startedAt - (slowTurn?.endedAt ?? 0)} ms after the slow turn ended`}; queue states ${slowState}/${nextRow?.state}; refused herdr calls: ${refusals === "" ? "none" : refusals}`,
  );
}

async function tenMessagesReachOnlyTheirAgent(workspace) {
  const room = await court(workspace);
  const first = await room.startAgent("shadow-pievidence-a");
  const second = await room.startAgent("shadow-pievidence-b");
  await room.startBackend();
  const words = Array.from({ length: 10 }, (_, index) => `${marker()}-${index}`);
  const ids = [];
  for (const word of words) {
    ids.push(room.send(first, `please answer ${word}`));
    await pause(100);
  }
  for (const id of ids) await room.waitForFinished(id, 90_000);
  await waitFor(() => words.every((word) => occurrences(first.standIn, word) === 1), 60_000);
  await pause(2000);
  const last = first.standIn.turns[first.standIn.turns.length - 1];
  const order = (last?.texts ?? []).map((text) => words.findIndex((word) => text.includes(word))).filter((index) => index >= 0);
  const inOrder = order.length === 10 && order.every((value, index) => value === index);
  const leaked = second.standIn.turns.filter((turn) => words.some((word) => turn.texts.some((text) => text.includes(word)))).length;
  const states = ids.map((id) => room.stateOf(id)?.state);
  const refusals = await room.refusals();
  await room.finish([first, second]);
  return verdict(
    inOrder && leaked === 0 && states.every((state) => state === "delivered") && refusals === "",
    `A received in order: ${order.join(",")}; provider turns of B carrying A's messages: ${leaked}; queue states: ${[...new Set(states)].join(",")}; refused herdr calls: ${refusals === "" ? "none" : refusals}`,
  );
}

async function noTypingAndNoHistoryRead(workspace) {
  const room = await court(workspace);
  const agent = await room.startAgent("shadow-pievidence-a");
  await room.startBackend();
  const idleWord = marker();
  const idleId = room.send(agent, `please answer ${idleWord}`);
  await room.waitForFinished(idleId);
  const slowWord = marker();
  room.send(agent, `${SLOW_TURN_WORD} ${slowWord}`);
  await waitFor(() => agent.standIn.turns.some((turn) => turn.latest.includes(slowWord)));
  const busyWord = marker();
  const busyId = room.send(agent, `please answer ${busyWord}`);
  const busyRow = await room.waitForFinished(busyId);
  await waitFor(() => occurrences(agent.standIn, busyWord) === 1);
  const refusals = await room.refusals();
  const delivered = room.stateOf(idleId)?.state === "delivered" && busyRow?.state === "delivered";
  const answered = occurrences(agent.standIn, idleWord) === 1 && occurrences(agent.standIn, busyWord) === 1;
  await room.finish([agent]);
  return verdict(
    delivered && answered && refusals === "",
    `the herdr client refused send-text, send-keys and agent read for the pi pane; idle and mid-turn deliveries both delivered: ${delivered}, both answered: ${answered}; refused calls attempted: ${refusals === "" ? "none" : refusals}`,
  );
}

async function missingExtensionFallsBackToTypedKeys(workspace) {
  const room = await court(workspace);
  const agent = await room.startAgent("shadow-pievidence-a", { withExtension: false });
  await room.startBackend({ typing: true });
  const answering = await room.answering(agent);
  const word = marker();
  const id = room.send(agent, `please answer ${word}`);
  const row = await room.waitForFinished(id);
  await waitFor(() => occurrences(agent.standIn, word) === 1, 30_000);
  await pause(2000);
  const once = occurrences(agent.standIn, word);
  const fallbackLines = room.backendOutput().split("\n").filter((line) => line.includes(`pi extension of "${agent.name}" is not answering`));
  await room.finish([agent]);
  return verdict(
    !answering && row?.state === "delivered" && once === 1 && fallbackLines.length === 1,
    `with no extension nothing answered on ${room.sockets[agent.name]}: ${!answering}; queue state ${row?.state}; message count in the conversation: ${once}; fallback lines: ${fallbackLines.length} (${fallbackLines.join(" | ").trim()})`,
  );
}

async function backendKillNeverDeliversTwice(workspace) {
  const room = await court(workspace);
  const agent = await room.startAgent("shadow-pievidence-a");
  await room.startBackend();
  await typeDraft(room, agent.paneId);
  const word = marker();
  const id = room.send(agent, `please answer ${word}`);
  await pause(DRAFT_HOLD_WINDOW_MILLISECONDS);
  const held = room.stateOf(id)?.state === "in-flight" && !agent.standIn.turns.some((turn) => turn.latest.includes(word));
  await room.killBackend();
  await room.startBackend();
  await room.herdr.call("pane", "send-keys", agent.paneId, "Enter");
  await waitFor(() => occurrences(agent.standIn, word) >= 1);
  await pause(6000);
  const once = occurrences(agent.standIn, word);
  const turnsCarrying = agent.standIn.turns.filter((turn) => turn.latest.includes(word)).length;
  const finalState = room.stateOf(id)?.state;
  const refusals = await room.refusals();
  await room.finish([agent]);
  return verdict(
    held && once === 1 && turnsCarrying === 1 && refusals === "",
    `the extension held the request behind the draft before the kill: ${held}; the kill closed the held connection; backend killed and restarted; message count in the conversation: ${once}; provider turns started by it: ${turnsCarrying}; queue state after restart: ${finalState}; refused herdr calls: ${refusals === "" ? "none" : refusals}`,
  );
}

export const lines = [
  { id: "P4.1", needsPane: true, run: idleAgentAnswersATurn },
  { id: "P4.2", needsPane: true, run: draftWaitsAndStaysIntact },
  { id: "P4.3", needsPane: true, run: midTurnMessageWaitsForTheTurn },
  { id: "P4.4", needsPane: true, run: tenMessagesReachOnlyTheirAgent },
  { id: "P4.5", needsPane: true, run: noTypingAndNoHistoryRead },
  { id: "P4.6", needsPane: true, run: missingExtensionFallsBackToTypedKeys },
  { id: "P4.7", needsPane: true, run: backendKillNeverDeliversTwice },
];
