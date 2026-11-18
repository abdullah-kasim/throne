import { deliveredTurns, deliver, saveJson, startModAgent, waitFor } from "./m3-mod-agent.mjs";

const COUNT = 10;

export async function check(harness) {
  const agentA = await startModAgent(harness, "a");
  const agentB = await startModAgent(harness, "b");
  const outcomes = [];
  for (let index = 1; index <= COUNT; index++) {
    outcomes.push((await deliver(harness, agentA, `Evidence said: message ${index} of ${COUNT}. Reply with only the word ok.`)).kind);
  }
  await agentA.saveScreen("a");
  await agentB.saveScreen("b");
  const turns = await waitFor(async () => {
    const found = await deliveredTurns(harness);
    return found.length >= COUNT ? found : undefined;
  }, 30_000) ?? (await deliveredTurns(harness));
  await saveJson(harness, "delivered-turns", turns);
  const sessions = [...new Set(turns.map((turn) => turn.session))];
  const order = turns.map((turn) => Number(/message (\d+) of/.exec(turn.text)?.[1]));
  const inOrder = order.join(",") === Array.from({ length: COUNT }, (_, index) => index + 1).join(",");
  const bScreen = await agentB.screen();
  return {
    verdict: outcomes.every((kind) => kind === "delivered") && inOrder && sessions.length === 1 && !bScreen.includes("message 1 of") ? "PASS" : "FAIL",
    observed: `client outcomes ${outcomes.join(",")}; delivered turns in order ${order.join(",")} all in ${sessions.length} session(s); agent B's pane shows none of them: ${!bScreen.includes("message 1 of")}`,
  };
}
