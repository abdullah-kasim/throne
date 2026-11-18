import { submittedPayload } from "../../../src/herdr/herdr-send.helpers.ts";
import { deliveredTurns, deliver, frameHolds, saveJson, startModAgent, waitFor } from "./m3-mod-agent.mjs";

const SENDER = "alpha-evidence-07";
const MESSAGE_NUMBER = "m-4821";
const QUESTION = "Who sent you this message and what is its message number? Reply on one line as: sender=<name> number=<number>";

function namesBoth(screen) {
  return screen.includes(SENDER) && screen.includes("4821") && /sender=/.test(screen);
}

export async function check(harness) {
  const payload = submittedPayload(SENDER, QUESTION, { messageId: MESSAGE_NUMBER });
  const modAgent = await startModAgent(harness, "mod");
  const typedAgent = await harness.startClaude({ name: "typed", claudeArguments: ["--setting-sources", "local", "--model", "haiku"] });
  const outcome = await deliver(harness, modAgent, payload);
  await typedAgent.submitTyped(payload);
  const modAnswer = await waitFor(async () => namesBoth((await modAgent.screen()).split("❯").slice(-2).join("")), 60_000);
  const typedAnswer = await waitFor(async () => namesBoth((await typedAgent.screen()).split("❯").slice(-2).join("")), 60_000);
  await modAgent.saveScreen("answer");
  await typedAgent.saveScreen("answer");
  const turns = await deliveredTurns(harness);
  await saveJson(harness, "delivered-turns", turns);
  const wrapperIntact = turns.length === 1 && frameHolds(turns[0], payload);
  return {
    verdict: outcome.kind === "delivered" && wrapperIntact && Boolean(modAnswer) && Boolean(typedAnswer) ? "PASS" : "FAIL",
    observed: `payload built by the typed path's submittedPayload: ${JSON.stringify(payload)}; the mod agent's turn holds it whole inside the plugin frame: ${wrapperIntact}; mod agent named ${SENDER} and the number: ${Boolean(modAnswer)}; typed agent named both: ${Boolean(typedAnswer)}`,
  };
}
