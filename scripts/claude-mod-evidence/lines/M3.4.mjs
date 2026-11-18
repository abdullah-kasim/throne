import { setTimeout as sleep } from "node:timers/promises";
import { answered, deliveredTurns, deliver, saveJson, startModAgent, userTurns } from "./m3-mod-agent.mjs";

const HOLD_SECONDS = 25;
const ANSWER = "OSPREY-12";

export async function check(harness) {
  const agent = await startModAgent(harness, "busy");
  await agent.holdTurn(HOLD_SECONDS);
  await sleep(6000);
  const delivery = deliver(harness, agent, `Evidence said: reply with exactly the word ${ANSWER}.`, 120_000);
  await sleep(5000);
  const midTurn = await agent.screen();
  await agent.saveScreen("mid-turn");
  const deliveredMidTurn = (await deliveredTurns(harness)).length;
  const outcome = await delivery;
  const answer = await answered(agent, ANSWER);
  const screen = await agent.screen();
  await agent.saveScreen("after");
  const turns = await userTurns(harness);
  await saveJson(harness, "user-turns", turns);
  const holdFinished = screen.includes("held") && !screen.includes("Interrupted");
  const order = turns.map((turn) => (turn.text.includes("hold-turn.py") ? "hold" : turn.text.includes(ANSWER) ? "message" : "other")).filter((kind) => kind !== "other");
  return {
    verdict: midTurn.includes("esc to interrupt") && deliveredMidTurn === 0 && outcome.kind === "delivered" && holdFinished && answer && order.join(",") === "hold,message" ? "PASS" : "FAIL",
    observed: `message sent 6s into a ${HOLD_SECONDS}s turn; delivered while the turn ran: ${deliveredMidTurn}; the hold turn finished with "held" and no interruption: ${holdFinished}; client ${outcome.kind}; user turn order ${order.join(",")}; agent answered: ${answer}`,
  };
}
