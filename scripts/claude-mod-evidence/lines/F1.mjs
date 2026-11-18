import { answered, saveJson, userTurns } from "./m3-mod-agent.mjs";
import { holdTurnRunning, openTimedCourt, positionsIn, statesUntil, TURN_RUNNING, waitForAccepted } from "./fire-and-forget.mjs";
import { ACCEPTED_WITHIN_MS, LONGEST_HOLD_MS } from "./timed-socket-proxy.mjs";

const HOLD_SECONDS = 40;
const ANSWER = "KESTREL-31";

export async function check(harness) {
  const { agent, proxy, court, close } = await openTimedCourt(harness, "midturn");
  try {
    const running = await holdTurnRunning(agent, HOLD_SECONDS);
    const id = await court.sendAgent(agent.name, `Reply with exactly the word ${ANSWER} and nothing else.`);
    const accepted = await waitForAccepted(proxy);
    const stillRunning = (await agent.screen()).includes(TURN_RUNNING);
    const states = await statesUntil(court, id, "delivered", 120_000);
    const answer = await answered(agent, ANSWER, 90_000);
    await agent.saveScreen("after");
    const turns = await userTurns(harness);
    await saveJson(harness, "user-turns", turns);
    const [holdAt, messageAt] = positionsIn(turns, ["hold-turn.py", ANSWER]);
    const deliveries = proxy.deliveries();
    const acceptedFast = deliveries.length >= 1 && deliveries.every((hold) => hold.answer === "accepted" && hold.milliseconds < ACCEPTED_WITHIN_MS);
    const pass = running && accepted && stillRunning && states.at(-1) === "delivered" && answer && holdAt !== -1 && messageAt > holdAt && acceptedFast && proxy.longest() <= LONGEST_HOLD_MS;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `message ${id} sent through throne send-agent while a ${HOLD_SECONDS}s turn ran (${running}); the agent answered accepted while the turn still ran: ${accepted && stillRunning}; message-status then read ${states.join(" -> ")}; the agent answered ${ANSWER} after the hold turn: ${answer && messageAt > holdAt}; socket connections and how long each was held: ${proxy.summary()}; every POST /deliver answered under ${ACCEPTED_WITHIN_MS}ms: ${acceptedFast}; longest hold ${proxy.longest()}ms (limit ${LONGEST_HOLD_MS}ms)`,
      figures: proxy.figures(),
    };
  } finally {
    await close();
  }
}
