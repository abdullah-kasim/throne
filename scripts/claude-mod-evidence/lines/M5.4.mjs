import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { deliverThroughExtension } from "../../../src/herdr/delivery-request-client.ts";
import { HARNESS_COMMAND_WAIT_MILLISECONDS } from "../../../src/agent-settings/harness-command-typing.ts";
import { saveJson, startModAgent, transcriptFolder, waitFor } from "./m3-mod-agent.mjs";

const HOLD_SECONDS = 40;
const SETTINGS_CHECK_PASS_MILLISECONDS = 3000;
const SENDING_LIMIT_MILLISECONDS = 180_000;
const COLOR_SET = "Session color set to";

async function transcriptRecords(harness) {
  const folder = transcriptFolder(harness);
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
  const records = [];
  for (const name of names) {
    for (const line of (await readFile(path.join(folder, name), "utf8")).split("\n")) {
      if (line.trim() !== "") records.push({ raw: line, row: JSON.parse(line) });
    }
  }
  return records;
}

function heldAt(records) {
  const held = records.find(({ row }) =>
    row.type === "assistant" && (row.message?.content ?? []).some((block) => block.type === "text" && /\bheld\b/i.test(block.text)),
  );
  return held?.row.timestamp;
}

export async function check(harness) {
  const agent = await startModAgent(harness, "colour");
  await agent.holdTurn(HOLD_SECONDS);
  await sleep(6000);
  const midTurn = await agent.screen();
  const sends = [];
  const started = Date.now();
  for (;;) {
    const sentAt = new Date().toISOString();
    const outcome = await deliverThroughExtension({ command: "color", args: "purple" }, HARNESS_COMMAND_WAIT_MILLISECONDS, agent.pane, { socketPath: agent.socket });
    sends.push({ sentAt, outcome: outcome.kind });
    if (outcome.kind === "delivered" || Date.now() - started > SENDING_LIMIT_MILLISECONDS) break;
    await sleep(SETTINGS_CHECK_PASS_MILLISECONDS);
  }
  await waitFor(async () => heldAt(await transcriptRecords(harness)) !== undefined, 30_000);
  await sleep(10_000);
  await agent.saveScreen("after");
  const records = await transcriptRecords(harness);
  const turnEnded = heldAt(records);
  const colorRecords = records.filter(({ raw }) => raw.includes("/color") || raw.includes(COLOR_SET));
  await saveJson(harness, "sends", sends);
  await saveJson(harness, "color-records", colorRecords.map(({ row }) => row));
  const colorSet = colorRecords.filter(({ raw }) => raw.includes(COLOR_SET));
  const commandsDuringTurn = colorRecords.filter(({ row }) => turnEnded === undefined || row.timestamp < turnEnded).length;
  const colorSetAfterTurn = colorSet.filter(({ row }) => turnEnded !== undefined && row.timestamp >= turnEnded).length;
  const busyDuringTurn = sends.filter((send) => send.outcome !== "delivered").length;
  return {
    verdict:
      midTurn.includes("esc to interrupt") && turnEnded !== undefined && busyDuringTurn > 0 && commandsDuringTurn === 0 && colorSet.length === 1 && colorSetAfterTurn === 1 ? "PASS" : "FAIL",
    observed: `/color purple sent every ${SETTINGS_CHECK_PASS_MILLISECONDS / 1000}s with a ${HARNESS_COMMAND_WAIT_MILLISECONDS} ms wait from 6s into a ${HOLD_SECONDS}s turn: ${sends.length} sends, ${busyDuringTurn} answered not delivered, last ${sends.at(-1)?.outcome}; turn ended ${turnEnded}; /color records during the turn ${commandsDuringTurn}; "${COLOR_SET}" records ${colorSet.length}, after the turn ${colorSetAfterTurn}`,
  };
}
