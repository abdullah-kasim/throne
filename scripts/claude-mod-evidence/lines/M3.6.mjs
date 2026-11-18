import { readFile } from "node:fs/promises";
import { writeGuardedHerdrClient } from "../guarded-herdr-client.mjs";
import { openIsolatedCourt, startCourtModAgent } from "../isolated-court.mjs";
import { answered, deliveredTurns, saveJson } from "./m3-mod-agent.mjs";

export async function check(harness) {
  const agent = await startCourtModAgent(harness, "guarded");
  const { clientPath, refusalLog } = await writeGuardedHerdrClient({ folder: harness.root, realClient: harness.herdrClient, recipients: [agent.pane] });
  const court = await openIsolatedCourt(harness, { herdrClientPath: clientPath });
  try {
    const idle = await court.sendAgent(agent.name, "Reply with only the word GANNET-1.");
    const idleAnswered = await answered(agent, "GANNET-1", 90_000);
    await agent.holdTurn(20);
    const midTurn = await court.sendAgent(agent.name, "Reply with only the word GANNET-2.");
    const midTurnAnswered = await answered(agent, "GANNET-2", 120_000);
    const statuses = [await court.waitForStatus(idle, "delivered", 30_000), await court.waitForStatus(midTurn, "delivered", 30_000)];
    await agent.saveScreen("answered");
    const refusals = await readFile(refusalLog, "utf8").catch(() => "");
    const turns = await deliveredTurns(harness);
    await saveJson(harness, "delivered-turns", turns);
    const pass = idleAnswered && midTurnAnswered && statuses.every((status) => status === "delivered") && refusals === "" && turns.length === 2;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `the isolated throne-backend and send-agent ran with a herdr client that refuses send-text, send-keys, pane read and agent read for pane ${agent.pane}; an idle message (${idle}) and a mid-turn message (${midTurn}) were answered: ${idleAnswered}, ${midTurnAnswered}; message-status: ${statuses.join(", ")}; refused herdr calls: ${refusals === "" ? "none" : refusals.trim()}; turns from the plugin: ${turns.length}`,
    };
  } finally {
    await court.close();
  }
}
