import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { agentAlive, deliverThroughExtension } from "../../../src/herdr/delivery-request-client.ts";
import { deliveryEnvironment } from "../../../src/herdr/delivery-socket-path.ts";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const MOD_FOLDER = path.join(repositoryRoot, "extensions", "claude");
export const PINNED_CLAUDE = path.join(repositoryRoot, "vendor", "node_modules", ".bin", "claude");
export const PLUGIN_FRAME = "The throne-delivery plugin sent a message:\n";
export const DELIVERY_LIMIT_MS = 90_000;

export function modSocket(harness, name) {
  return path.join(harness.root, `${name}.sock`);
}

export async function startModAgent(harness, name, folder = MOD_FOLDER) {
  const socket = modSocket(harness, name);
  const agent = await harness.startClaude({
    name,
    claudeArguments: ["--plugin-dir", folder, "--setting-sources", "local", "--model", "haiku"],
    launchEnvironment: deliveryEnvironment(socket, true),
  });
  return { ...agent, socket };
}

export function deliver(harness, agent, text, limitMs = DELIVERY_LIMIT_MS) {
  return deliverThroughExtension(text, limitMs, agent.pane, { socketPath: agent.socket });
}

export async function answering(agent) {
  return (await agentAlive(agent.socket, agent.pane)) !== undefined;
}

function transcriptFolder(harness) {
  return path.join(harness.claudeConfig, "projects", harness.repo.replace(/[^A-Za-z0-9]/g, "-"));
}

export async function userTurns(harness) {
  const folder = transcriptFolder(harness);
  const names = await readdir(folder).catch(() => []);
  const turns = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
    for (const line of (await readFile(path.join(folder, name), "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line);
      if (row.type !== "user" || row.message?.role !== "user") continue;
      const content = row.message.content;
      const text = typeof content === "string" ? content : (content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
      if (text !== "") turns.push({ session: name, text });
    }
  }
  return turns;
}

export async function deliveredTurns(harness) {
  return (await userTurns(harness)).filter((turn) => turn.text.startsWith(PLUGIN_FRAME));
}

export function frameHolds(turn, text) {
  return turn.text.startsWith(`${PLUGIN_FRAME}${text}\n\n`);
}

export async function waitFor(condition, limitMs, pollMs = 1000) {
  const started = Date.now();
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() - started > limitMs) return value;
    await sleep(pollMs);
  }
}

export async function saveJson(harness, label, value) {
  return harness.saveText(label, JSON.stringify(value, null, 2));
}

export async function validateMod() {
  const { stdout } = await run(PINNED_CLAUDE, ["plugin", "validate", MOD_FOLDER]);
  return stdout;
}

export async function answered(agent, word, limitMs = 60_000) {
  return waitFor(async () => (await agent.screen()).includes(`● ${word}`), limitMs);
}
