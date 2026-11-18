import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openIsolatedCourt, recordModAgent, startCourtModAgent } from "../isolated-court.mjs";
import { startTimedSocketProxy } from "./timed-socket-proxy.mjs";
import { helperProcesses } from "./court-agent.mjs";
import { writeGuardedHerdrClient } from "../guarded-herdr-client.mjs";
import { waitFor } from "./m3-mod-agent.mjs";

export const TURN_RUNNING = "esc to interrupt";

export async function openTimedCourt(harness, name, { callbacks = true, guarded = false } = {}) {
  const agent = await startCourtModAgent(harness, name, { callbacks });
  const proxy = await startTimedSocketProxy(path.join(harness.root, `${name}-timed.sock`), agent.socket);
  await recordModAgent(harness, { ...agent, socket: proxy.path });
  const guard = guarded ? await writeGuardedHerdrClient({ folder: harness.root, realClient: harness.herdrClient, recipients: [agent.pane] }) : undefined;
  const court = await openIsolatedCourt(harness, guard === undefined ? {} : { herdrClientPath: guard.clientPath });
  return {
    agent,
    proxy,
    court,
    refusalLog: guard?.refusalLog,
    close: async () => {
      await court.close();
      await proxy.close();
    },
  };
}

export async function holdTurnRunning(agent, seconds) {
  await agent.holdTurn(seconds);
  return Boolean(await waitFor(async () => (await agent.screen()).includes(TURN_RUNNING), 30_000, 500));
}

async function groupMembers(group) {
  const members = [];
  for (const pid of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/u.test(pid)) continue;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === group) members.push(Number(pid));
  }
  return members;
}

export async function freezeClaude(harness, agent) {
  const info = JSON.parse(await harness.herdr("pane", "process-info", "--pane", agent.pane)).result.process_info;
  const helpers = new Set(await helperProcesses(agent.socket));
  const frozen = (await groupMembers(info.foreground_process_group_id)).filter((pid) => !helpers.has(pid));
  if (frozen.length === 0) throw new Error(`no Claude process found for pane ${agent.pane}`);
  for (const pid of frozen) process.kill(pid, "SIGSTOP");
  const resume = () => {
    for (const pid of frozen) process.kill(pid, "SIGCONT");
  };
  resume.describe = async () =>
    (
      await Promise.all(
        frozen.map(async (pid) => {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
          const name = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0")[0].split("/").at(-1);
          return `${pid} ${name} ${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]}`;
        }),
      )
    ).join(", ");
  return resume;
}

export function allAccepted(proxy, count = 1) {
  const deliveries = proxy.deliveries();
  return deliveries.length >= count && deliveries.every((hold) => hold.answer === "accepted");
}

export async function waitForAccepted(proxy, count = 1, limitMs = 15_000) {
  return Boolean(await waitFor(() => allAccepted(proxy, count), limitMs, 50));
}

export async function statesUntil(court, id, wanted, limitMs) {
  const seen = [];
  const started = Date.now();
  for (;;) {
    const status = await court.messageStatus(id);
    if (seen.at(-1) !== status) seen.push(status);
    if (status === wanted || Date.now() - started > limitMs) return seen;
    await sleep(500);
  }
}

export function positionsIn(turns, tokens) {
  const text = turns.map((turn) => turn.text).join("\n");
  return tokens.map((token) => text.indexOf(token));
}

export function timesIn(turns, token) {
  return turns.map((turn) => turn.text.split(token).length - 1).reduce((sum, count) => sum + count, 0);
}
