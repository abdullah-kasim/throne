import { openIsolatedCourt, startCourtModAgent } from "../isolated-court.mjs";
import { answered, deliveredTurns, saveJson } from "./m3-mod-agent.mjs";

const ANSWER = "PELICAN-41";

export async function check(harness) {
  const agent = await startCourtModAgent(harness, "idle");
  const court = await openIsolatedCourt(harness);
  try {
    const id = await court.sendAgent(agent.name, `Reply with exactly the word ${ANSWER} and nothing else.`);
    const answer = await answered(agent, ANSWER, 90_000);
    const status = await court.waitForStatus(id, "delivered", 30_000);
    await agent.saveScreen("answered");
    const turns = await deliveredTurns(harness);
    await saveJson(harness, "delivered-turns", turns);
    return {
      verdict: answer && status === "delivered" && turns.length === 1 ? "PASS" : "FAIL",
      observed: `throne send-agent queued message ${id} against an isolated throne-backend; the agent answered ${ANSWER}: ${answer}; turns from the plugin: ${turns.length}; throne message-status ${id}: ${status}`,
    };
  } finally {
    await court.close();
  }
}
