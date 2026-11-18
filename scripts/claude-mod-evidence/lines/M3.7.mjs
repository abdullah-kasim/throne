import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { answering, deliveredTurns, saveJson, waitFor } from "./m3-mod-agent.mjs";
import { freezeClaude, openTimedCourt, statesUntil, waitForAccepted } from "./fire-and-forget.mjs";

const DOWN_AFTER_RESUME_MS = 10_000;
const MESSAGE = "Reply with only the word OSPREY-7.";

async function turnsHoldingMessage(harness) {
  return (await deliveredTurns(harness)).filter((turn) => turn.text.includes(MESSAGE));
}

export async function check(harness) {
  const { agent, proxy, court, refusalLog, close } = await openTimedCourt(harness, "restart", { guarded: true });
  let resume;
  try {
    const listening = await waitFor(() => answering(agent), 30_000, 200);
    resume = await freezeClaude(harness, agent);
    const id = await court.sendAgent(agent.name, MESSAGE);
    const accepted = await waitForAccepted(proxy);
    const frozen = await resume.describe();
    const beforeKill = await court.messageStatus(id);
    await court.killBackend();
    resume();
    resume = undefined;
    const turnsWhileDown = (await waitFor(async () => (await turnsHoldingMessage(harness)).length, 60_000)) || 0;
    await sleep(DOWN_AFTER_RESUME_MS);
    await court.startBackend();
    const afterRestart = await statesUntil(court, id, "delivered", 60_000);
    await agent.saveScreen("after-restart");
    const turns = await turnsHoldingMessage(harness);
    await saveJson(harness, "delivered-turns", turns);
    const refusals = await readFile(refusalLog, "utf8").catch(() => "");
    const pass = listening && accepted && beforeKill === "accepted" && turnsWhileDown === 1 && afterRestart.at(-1) === "delivered" && turns.length === 1 && refusals === "";
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `the agent's Claude processes were stopped with SIGSTOP (pid, name, state: ${frozen}) so it could not take the message; message ${id} was answered accepted: ${accepted}; message-status before the kill: ${beforeKill}; the isolated throne-backend was SIGKILLed and the agent resumed; while the backend was down the agent ran the message: ${turnsWhileDown} turn(s); the backend stayed down ${DOWN_AFTER_RESUME_MS / 1000}s more, then restarted (${court.backendStarts()} starts); message-status went ${afterRestart.join(" -> ")} as the agent's retried callback arrived; turns holding the message: ${turns.length}; socket holds: ${proxy.summary()}; typed-key or pane-read calls refused: ${refusals === "" ? "none" : refusals.trim()}`,
    };
  } finally {
    resume?.();
    await close();
  }
}
