import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PLUGIN_FRAME, userTurns, waitFor } from "./m3-mod-agent.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETTLE_AFTER_RESTART_MS = 20_000;

export async function turnsHolding(harness, token) {
  return (await userTurns(harness)).filter((turn) => turn.text.includes(token));
}

export async function deliveredByMod(harness, token) {
  const turns = await turnsHolding(harness, token);
  return { count: turns.length, byMod: turns.filter((turn) => turn.text.startsWith(PLUGIN_FRAME)).length, sessions: turns.map((turn) => turn.session) };
}

export async function waitForTurns(harness, tokens, limitMs) {
  return waitFor(async () => {
    for (const token of tokens) if ((await turnsHolding(harness, token)).length === 0) return false;
    return true;
  }, limitMs);
}

export async function waitForEveryStatus(court, ids, limitMs) {
  const statuses = [];
  for (const id of ids) statuses.push(await court.waitForStatus(id, "delivered", limitMs));
  return statuses;
}

async function counts(harness, tokens) {
  return Promise.all(tokens.map(async (token) => (await turnsHolding(harness, token)).length));
}

export async function restartAndRecheck(harness, court, sent) {
  const tokens = sent.map((message) => message.token);
  const before = await counts(harness, tokens);
  await court.killBackend();
  await court.startBackend();
  await sleep(SETTLE_AFTER_RESTART_MS);
  const after = await counts(harness, tokens);
  const statuses = await Promise.all(sent.map((message) => court.messageStatus(message.id)));
  const doubled = tokens.filter((_, index) => after[index] !== before[index]);
  const notDelivered = sent.map((message, index) => `${message.id}: ${statuses[index]}`).filter((_, index) => statuses[index] !== "delivered");
  await harness.saveText("after-backend-restart", JSON.stringify({ before, after, statuses }, null, 2));
  return {
    holds: doubled.length === 0 && notDelivered.length === 0,
    summary: `after restarting the run's own backend (${court.backendStarts()} starts) and ${SETTLE_AFTER_RESTART_MS / 1000}s: messages whose turn count changed: ${doubled.length === 0 ? "none" : doubled.join(", ")}; message-status not delivered: ${notDelivered.length === 0 ? "none" : notDelivered.join("; ")}`,
  };
}

export async function courtThroneCommand(harness, court) {
  const file = path.join(harness.root, "throne");
  const { THRONE_AGENT_NAME: _sender, HERDR_PANE_ID: _pane, ...environment } = court.environment;
  const exports = Object.entries(environment)
    .filter(([name]) => /^(THRONE_|XDG_|HOME$|PATH$|CLAUDE_CONFIG_DIR$)/u.test(name))
    .map(([name, value]) => `export ${name}='${String(value).replaceAll("'", "'\\''")}'`)
    .join("\n");
  await writeFile(file, `#!/usr/bin/env bash\n${exports}\nexec '${path.join(repositoryRoot, "bin", "throne-cli")}' "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

export function uncertainLines(logText, name) {
  return logText.split("\n").filter((line) => line.includes(`"${name}"`) && /assumed filled|uncertain|not sent/u.test(line));
}
