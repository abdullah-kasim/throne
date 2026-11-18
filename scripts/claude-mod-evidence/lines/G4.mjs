import { setTimeout as sleep } from "node:timers/promises";
import { openIsolatedCourt } from "../isolated-court.mjs";
import { waitForAnswering } from "./court-agent.mjs";
import { saveJson, userTurns } from "./m3-mod-agent.mjs";
import { restartAndRecheck, turnsHolding, waitForEveryStatus, waitForTurns } from "./flow.mjs";

const DRAFT = "person's half typed draft g4 keep me";
const HOLD_MS = 120_000;
const LOOK_EVERY_MS = 10_000;
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
    const started = Date.now();
    const looks = [];
    while (Date.now() - started < HOLD_MS) {
      await sleep(LOOK_EVERY_MS);
      let arrived = 0;
      for (const message of sent) arrived += (await turnsHolding(harness, message.token)).length;
      looks.push({ seconds: Math.round((Date.now() - started) / 1000), same: draftLine(await agent.screen()) === first, arrived });
    }
    await harness.saveText("g4-draft-held", await agent.screen());
    await harness.herdr("pane", "send-keys", agent.pane, "enter");
    const statuses = await waitForEveryStatus(court, sent.map((message) => message.id), 180_000);
    await waitForTurns(harness, sent.map((message) => message.token), 120_000);
    const turns = await userTurns(harness);
    await saveJson(harness, "g4-turns", turns);
    const draftAt = turns.findIndex((turn) => turn.text.includes(DRAFT));
    const positions = sent.map((message) => turns.findIndex((turn) => turn.text.includes(message.token)));
    const counts = sent.map((message) => turns.filter((turn) => turn.text.includes(message.token)).length);
    const inOrder = positions.every((position, index) => position > draftAt && (index === 0 || position > positions[index - 1]));
    const recheck = await restartAndRecheck(harness, court, sent);
    const held = first !== null && looks.every((look) => look.same && look.arrived === 0);
    const pass = held && draftAt !== -1 && statuses.every((status) => status === "delivered") && counts.every((count) => count === 1) && inOrder && recheck.holds;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `real create-agent ${agent.name}; a draft was typed into its composer and ${COUNT} messages queued; over ${HOLD_MS / 1000}s, looked at every ${LOOK_EVERY_MS / 1000}s: draft line unchanged at every look: ${looks.every((look) => look.same)}, messages arrived while the draft sat: ${Math.max(...looks.map((look) => look.arrived))}; after the draft was submitted (turn ${draftAt}): message-status ${statuses.join(",")}, each arrived ${counts.join(",")} time(s), at turns ${positions.join(",")}, in order after the draft: ${inOrder}; ${recheck.summary}`,
    };
  } finally {
    await court.close();
  }
}
