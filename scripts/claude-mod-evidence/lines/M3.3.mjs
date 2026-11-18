import { setTimeout as sleep } from "node:timers/promises";
import { answered, saveJson, userTurns } from "./m3-mod-agent.mjs";
import { openTimedCourt, statesUntil, timesIn } from "./fire-and-forget.mjs";
import { ACCEPTED_WITHIN_MS } from "./timed-socket-proxy.mjs";

const DRAFT = "half typed draft: keep me 9q";
const ANSWER = "HERON-77";

function draftLine(screen) {
  return screen.split("\n").find((line) => line.includes(DRAFT)) ?? null;
}

export async function check(harness) {
  const { agent, proxy, court, close } = await openTimedCourt(harness, "draft");
  try {
    await agent.putDraft(DRAFT);
    await sleep(1000);
    const before = draftLine(await agent.screen());
    const id = await court.sendAgent(agent.name, `Reply with exactly the word ${ANSWER}.`);
    const states = await statesUntil(court, id, "delivered", 60_000);
    const answer = await answered(agent, ANSWER);
    await sleep(2000);
    const after = draftLine(await agent.screen());
    await agent.saveScreen("after");
    const turns = await userTurns(harness);
    await saveJson(harness, "user-turns", turns);
    const deliveries = proxy.deliveries();
    const acceptedFast = deliveries.length >= 1 && deliveries.every((hold) => hold.answer === "accepted" && hold.milliseconds < ACCEPTED_WITHIN_MS);
    const draftSubmitted = timesIn(turns, DRAFT) > 0;
    const pass = before !== null && acceptedFast && states.at(-1) === "delivered" && answer && after === before && !draftSubmitted;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `a draft sat in the box when message ${id} was sent; POST /deliver answered ${proxy.summary()}; message-status went ${states.join(" -> ")}; the agent answered ${ANSWER}: ${answer}; the draft line after the answer is identical to before: ${after === before}; the draft was itself submitted: ${draftSubmitted}`,
    };
  } finally {
    await close();
  }
}
