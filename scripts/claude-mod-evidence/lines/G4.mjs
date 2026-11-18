import { setTimeout as sleep } from "node:timers/promises";
import { openIsolatedCourt } from "../isolated-court.mjs";
import { waitForAnswering } from "./court-agent.mjs";
import { saveJson, userTurns } from "./m3-mod-agent.mjs";
import { restartAndRecheck, waitForEveryStatus, waitForTurns } from "./flow.mjs";
import { positionsIn, timesIn } from "./fire-and-forget.mjs";

const DRAFT = "person's half typed draft g4 keep me";
const COUNT = 5;

function draftLine(screen) {
  return screen.split("\n").find((line) => line.includes(DRAFT)) ?? null;
}

export async function check(harness) {
  const court = await openIsolatedCourt(harness);
  try {
    const agent = await court.createAgent("g4");
    await waitForAnswering(agent);
    await harness.herdr("pane", "send-text", agent.pane, DRAFT);
    await sleep(1000);
    const first = draftLine(await agent.screen());
    const sent = [];
    for (let index = 1; index <= COUNT; index++) {
      const token = `G4-QUEUED-${index}`;
      sent.push({ id: await court.sendAgent(agent.name, `Message ${token}. Reply with only the word ok.`), token });
    }
    const statuses = await waitForEveryStatus(court, sent.map((message) => message.id), 300_000);
    await waitForTurns(harness, sent.map((message) => message.token), 120_000);
    await sleep(3000);
    const last = draftLine(await agent.screen());
    await harness.saveText("g4-draft-after", await agent.screen());
    const turns = await userTurns(harness);
    await saveJson(harness, "g4-turns", turns);
    const positions = positionsIn(turns, sent.map((message) => message.token));
    const counts = sent.map((message) => timesIn(turns, message.token));
    const inOrder = positions.every((position, index) => position !== -1 && (index === 0 || position > positions[index - 1]));
    const draftSubmitted = timesIn(turns, DRAFT) > 0;
    const recheck = await restartAndRecheck(harness, court, sent);
    const pass = first !== null && last === first && !draftSubmitted && statuses.every((status) => status === "delivered") && counts.every((count) => count === 1) && inOrder && recheck.holds;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `real create-agent ${agent.name}; a draft was typed into its composer and ${COUNT} messages sent; message-status ${statuses.join(",")}; each arrived ${counts.join(",")} time(s), in order: ${inOrder}; the draft line is unchanged after all five: ${last === first}; the draft was itself submitted: ${draftSubmitted}; ${recheck.summary}`,
    };
  } finally {
    await court.close();
  }
}
