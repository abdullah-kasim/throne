import { setTimeout as sleep } from "node:timers/promises";
import { openIsolatedCourt } from "../isolated-court.mjs";
import { answering } from "./m3-mod-agent.mjs";
import { fallbackLines, stopHelper, modTurnsHolding, screenShows, shownTimes, TYPED_PREFIX, waitForAnswering, waitForSilence } from "./court-agent.mjs";

export async function modStoppedAnswering(harness, name) {
  const court = await openIsolatedCourt(harness);
  let stopKilling;
  try {
    const agent = await court.createAgent(name);
    const record = await court.spawnRecord(agent.name);
    await waitForAnswering(agent);
    const first = `Reply with exactly the word ${name.toUpperCase()}-ONE and nothing else.`;
    const firstId = await court.sendAgent(agent.name, first);
    await screenShows(agent, `● ${name.toUpperCase()}-ONE`);
    const firstStatus = await court.waitForStatus(firstId, "delivered", 30_000);
    const firstModTurns = (await modTurnsHolding(harness, first)).length;
    const linesBefore = (await fallbackLines(court, agent.name)).length;
    stopKilling = await stopHelper(agent.socket);
    const silent = await waitForSilence(agent);
    const second = `reply with the single word ${name}-two`;
    const sentAt = Date.now();
    const secondId = await court.sendAgent(agent.name, second);
    const secondStatus = await court.waitForStatus(secondId, "delivered", 60_000);
    const fallbackSeconds = (Date.now() - sentAt) / 1000;
    const answeringWhileStopped = await answering(agent);
    await screenShows(agent, `${TYPED_PREFIX}${second}`, 30_000);
    const kills = await stopKilling();
    stopKilling = undefined;
    const answeringAgain = Boolean(await waitForAnswering(agent, 30_000));
    await sleep(8000);
    const screen = await agent.screen();
    await harness.saveText(`${name}-after-fallback`, screen);
    const lines = (await fallbackLines(court, agent.name)).slice(linesBefore);
    await harness.saveText(`${name}-fallback-lines`, lines.join("\n"));
    const secondModTurns = (await modTurnsHolding(harness, second)).length;
    const typedShown = shownTimes(screen, `${TYPED_PREFIX}${second}`);
    return {
      record,
      firstModTurns,
      firstStatus,
      silent,
      secondStatus,
      fallbackSeconds,
      answeringWhileStopped,
      answeringAgain,
      lines,
      secondModTurns,
      typedShown,
      summary: `real create-agent ${agent.name}: spawn.json claude_mod ${record.claude_mod}, delivery_socket ${record.delivery_socket}; first message ${firstId} went by the mod (${firstModTurns} mod turn, ${firstStatus}); then its helper was killed (${kills} process(es)) with the helper script made unreadable so the mod's restart could not listen (Claude itself kept running), and the socket stopped answering: ${Boolean(silent)}; second message ${secondId} was ${secondStatus} ${fallbackSeconds}s after send-agent; the socket answered while the helper was killed: ${answeringWhileStopped}; the typed message is shown ${typedShown} time(s) and reached the mod ${secondModTurns} time(s); once the script was readable again the mod's restarted helper answered again: ${answeringAgain}; backend lines: ${lines.join(" | ").trim()}`,
    };
  } finally {
    await stopKilling?.();
    await court.close();
  }
}
