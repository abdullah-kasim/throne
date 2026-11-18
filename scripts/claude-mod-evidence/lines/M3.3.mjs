import { setTimeout as sleep } from "node:timers/promises";
import { answered, deliveredTurns, deliver, saveJson, startModAgent } from "./m3-mod-agent.mjs";

const DRAFT = "half typed draft: keep me 9q";
const ANSWER = "HERON-77";

export async function check(harness) {
  const agent = await startModAgent(harness, "draft");
  await agent.putDraft(DRAFT);
  await sleep(1000);
  const before = await agent.screen();
  const delivery = deliver(harness, agent, `Evidence said: reply with exactly the word ${ANSWER}.`);
  await sleep(10_000);
  const during = await agent.screen();
  await agent.saveScreen("draft-held");
  const heldTurns = (await deliveredTurns(harness)).length;
  const draftLine = (screen) => screen.split("\n").find((line) => line.includes(DRAFT)) ?? null;
  const draftUnchanged = draftLine(before) !== null && draftLine(before) === draftLine(during);
  await agent.clearDraft();
  const outcome = await delivery;
  const answer = await answered(agent, ANSWER);
  await agent.saveScreen("after-clear");
  const turns = await deliveredTurns(harness);
  await saveJson(harness, "delivered-turns", turns);
  return {
    verdict: heldTurns === 0 && draftUnchanged && outcome.kind === "delivered" && turns.length === 1 && answer ? "PASS" : "FAIL",
    observed: `10s with the draft resident: delivered turns ${heldTurns}; draft line on screen identical before and during (draft text and the cursor after it): ${draftUnchanged}; after ctrl+u the client reports ${outcome.kind}, delivered turns ${turns.length}, agent answered: ${answer}`,
  };
}
