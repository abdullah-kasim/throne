import { chmod, readdir, readFile, readlink, stat } from "node:fs/promises";
import { DELIVERY_HELPER_PATH } from "../../../src/herdr/delivery-socket-path.ts";
import { answering, deliveredTurns, waitFor } from "./m3-mod-agent.mjs";

export const TYPED_PREFIX = "evidence-sender said: ";

export function shownTimes(screen, text) {
  return screen.split(text).length - 1;
}

export async function screenShows(agent, text, limitMs = 90_000) {
  return waitFor(async () => (await agent.screen()).includes(text), limitMs);
}

export async function modTurnsHolding(harness, text) {
  return (await deliveredTurns(harness)).filter((turn) => turn.text.includes(text));
}

export async function waitForAnswering(agent, limitMs = 60_000) {
  return waitFor(() => answering(agent), limitMs);
}

export async function waitForSilence(agent, limitMs = 30_000) {
  return waitFor(async () => !(await answering(agent)), limitMs);
}

export async function helperProcesses(socket) {
  const found = [];
  for (const pid of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/u.test(pid)) continue;
    const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    if (!environ.split("\0").includes(`THRONE_DELIVERY_SOCKET=${socket}`)) continue;
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (argv.some((word) => word.endsWith("delivery-helper.ts"))) found.push(Number(pid));
  }
  return found;
}

export async function stopHelper(socket, script = DELIVERY_HELPER_PATH) {
  const mode = (await stat(script)).mode & 0o777;
  await chmod(script, 0o000);
  const pids = await helperProcesses(socket);
  for (const pid of pids) process.kill(pid, "SIGKILL");
  return async () => {
    await chmod(script, mode);
    return pids.length;
  };
}

export async function launchArgv(pane, cwd) {
  for (const pid of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/u.test(pid)) continue;
    const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    if (!environ.split("\0").includes(`HERDR_PANE_ID=${pane}`)) continue;
    if ((await readlink(`/proc/${pid}/cwd`).catch(() => "")) !== cwd) continue;
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean);
    const configFolder = environ.split("\0").find((entry) => entry.startsWith("CLAUDE_CONFIG_DIR="))?.slice("CLAUDE_CONFIG_DIR=".length);
    if (argv.some((word) => /(^|\/)(claude|codex)$/u.test(word))) return { pid: Number(pid), argv, configFolder };
  }
  return undefined;
}

export async function fallbackLines(court, name) {
  return (await court.backendLogText()).split("\n").filter((line) => line.includes(`Claude mod of "${name}" is not answering`));
}

