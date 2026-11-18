import { agentAlive } from "../../../src/herdr/delivery-request-client.ts";
import { answered } from "./m3-mod-agent.mjs";
import { holdTurnRunning, openTimedCourt, statesUntil } from "./fire-and-forget.mjs";

const HOLD_SECONDS = 25;
const ANSWER = "PLOVER-8";

export async function check(harness) {
  const { agent, proxy, court, close } = await openTimedCourt(harness, "old", { callbacks: false });
  try {
    const alive = await agentAlive(agent.socket, agent.pane);
    const running = await holdTurnRunning(agent, HOLD_SECONDS);
    const id = await court.sendAgent(agent.name, `Reply with exactly the word ${ANSWER} and nothing else.`);
    const states = await statesUntil(court, id, "delivered", 120_000);
    const answer = await answered(agent, ANSWER, 90_000);
    await agent.saveScreen("after");
    const longestDelivery = Math.max(0, ...proxy.deliveries().map((hold) => hold.milliseconds));
    const pass = alive !== undefined && alive.callbacks === undefined && running && !states.includes("accepted") && states.at(-1) === "delivered" && answer && longestDelivery > 2000;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `an agent launched without a callback socket answers GET /alive with ${JSON.stringify(alive)}; message ${id} sent during a ${HOLD_SECONDS}s turn (${running}); message-status went ${states.join(" -> ")}, never accepted; the agent answered ${ANSWER}: ${answer}; socket holds: ${proxy.summary()}, the delivery request held ${longestDelivery}ms until the turn ended, as the held request does`,
    };
  } finally {
    await close();
  }
}
