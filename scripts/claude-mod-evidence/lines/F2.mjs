import { saveJson, userTurns, waitFor } from "./m3-mod-agent.mjs";
import { holdTurnRunning, openTimedCourt, positionsIn, statesUntil, timesIn, waitForAccepted } from "./fire-and-forget.mjs";
import { LONGEST_HOLD_MS } from "./timed-socket-proxy.mjs";

const HOLD_SECONDS = 40;
const TOKENS = ["WREN-1", "WREN-2", "WREN-3"];

export async function check(harness) {
  const { agent, proxy, court, close } = await openTimedCourt(harness, "three");
  try {
    const running = await holdTurnRunning(agent, HOLD_SECONDS);
    const ids = [];
    for (const token of TOKENS) ids.push(await court.sendAgent(agent.name, `Message ${token}. Reply with only the word ok.`));
    const accepted = await waitForAccepted(proxy, TOKENS.length, 30_000);
    const finalStates = [];
    for (const id of ids) finalStates.push((await statesUntil(court, id, "delivered", 240_000)).at(-1));
    const turns = (await waitFor(async () => {
      const found = await userTurns(harness);
      return TOKENS.every((token) => timesIn(found, token) >= 1) ? found : undefined;
    }, 60_000)) ?? (await userTurns(harness));
    await saveJson(harness, "user-turns", turns);
    await agent.saveScreen("after");
    const positions = positionsIn(turns, TOKENS);
    const counts = TOKENS.map((token) => timesIn(turns, token));
    const inOrder = positions.every((position, index) => position !== -1 && (index === 0 || position > positions[index - 1]));
    const pass = running && accepted && finalStates.every((state) => state === "delivered") && inOrder && counts.every((count) => count === 1) && proxy.longest() <= LONGEST_HOLD_MS;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `three messages ${ids.join(", ")} sent one after another during one ${HOLD_SECONDS}s turn (${running}); the agent answered accepted to each: ${accepted}; message-status then read ${finalStates.join(",")}; received in the order sent: ${inOrder} (text positions ${positions.join(",")}); times each was received: ${counts.join(",")}; socket holds: ${proxy.summary()}; longest hold ${proxy.longest()}ms (limit ${LONGEST_HOLD_MS}ms)`,
      figures: proxy.figures(),
    };
  } finally {
    await close();
  }
}
