import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { writeGuardedHerdrClient } from "../guarded-herdr-client.mjs";
import { openIsolatedCourt, startCourtModAgent } from "../isolated-court.mjs";
import { answering, deliveredTurns, saveJson, waitFor } from "./m3-mod-agent.mjs";

const HOLD_SECONDS = 40;
const AFTER_RESTART_MS = 60_000;
const MESSAGE = "Reply with only the word OSPREY-7.";

async function turnsHoldingMessage(harness) {
  return (await deliveredTurns(harness)).filter((turn) => turn.text.includes(MESSAGE));
}

export async function check(harness) {
  const agent = await startCourtModAgent(harness, "restart");
  const { clientPath, refusalLog } = await writeGuardedHerdrClient({ folder: harness.root, realClient: harness.herdrClient, recipients: [agent.pane] });
  const court = await openIsolatedCourt(harness, { herdrClientPath: clientPath });
  try {
    const listening = await waitFor(() => answering(agent), 30_000, 200);
    await agent.holdTurn(HOLD_SECONDS);
    await sleep(5000);
    const id = await court.sendAgent(agent.name, MESSAGE);
    await sleep(3000);
    const turnsBeforeKill = (await turnsHoldingMessage(harness)).length;
    await court.killBackend();
    await sleep(HOLD_SECONDS * 1000 + 10_000);
    const turnsWhileDown = (await turnsHoldingMessage(harness)).length;
    await court.startBackend();
    await sleep(AFTER_RESTART_MS);
    const status = await court.messageStatus(id);
    await agent.saveScreen("after-restart");
    const turns = await turnsHoldingMessage(harness);
    await saveJson(harness, "delivered-turns", turns);
    const refusals = await readFile(refusalLog, "utf8").catch(() => "");
    const pass = listening && turnsBeforeKill === 0 && turnsWhileDown === 0 && turns.length === 1 && refusals === "";
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `the mod's socket ${agent.socket} answered before the send: ${Boolean(listening)}; message ${id} sent while the agent was mid-turn, so the helper held the connection; turns holding it before the kill: ${turnsBeforeKill}; the isolated throne-backend was SIGKILLed, closing the held connection; turns holding it while the backend was down past the end of the running turn: ${turnsWhileDown}; the backend restarted (${court.backendStarts()} starts) and ran ${AFTER_RESTART_MS / 1000}s; turns holding the message: ${turns.length}; typed-key or pane-read calls refused: ${refusals === "" ? "none" : refusals.trim()}; message-status ${id}: ${status}`,
    };
  } finally {
    await court.close();
  }
}
