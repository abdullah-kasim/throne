import { openIsolatedCourt } from "../isolated-court.mjs";
import { launchArgv, modTurnsHolding, screenShows, waitForAnswering } from "./court-agent.mjs";

const ANSWER = "HERON-21";
const ASKED_TO_ENABLE = /enable (this )?plugin|trust this plugin|install plugin/iu;

export async function check(harness) {
  const court = await openIsolatedCourt(harness);
  try {
    const agent = await court.createAgent("m21");
    const alive = await waitForAnswering(agent);
    const firstScreen = await agent.screen();
    await harness.saveText("m21-after-launch", firstScreen);
    const process = await launchArgv(agent.pane, harness.repo);
    const record = await court.spawnRecord(agent.name);
    const message = `Reply with exactly the word ${ANSWER} and nothing else.`;
    const id = await court.sendAgent(agent.name, message);
    const answer = await screenShows(agent, `● ${ANSWER}`);
    const status = await court.waitForStatus(id, "delivered", 30_000);
    const turns = await modTurnsHolding(harness, message);
    await harness.saveText("m21-answered", await agent.screen());
    const pluginLoaded = process?.argv.includes("--plugin-dir") === true;
    const pass = pluginLoaded && record.claude_mod === true && alive && !ASKED_TO_ENABLE.test(firstScreen) && answer && status === "delivered" && turns.length === 1;
    const ownConfig = process?.configFolder === harness.claudeConfig;
    return {
      verdict: pass && ownConfig ? "PASS" : "FAIL",
      observed: `its CLAUDE_CONFIG_DIR is ${process?.configFolder} (the run's own copy: ${ownConfig}); real throne create-agent launched ${agent.name}; its process argv: ${process?.argv.join(" ") ?? "not found"}; spawn.json claude_mod: ${record.claude_mod}; the mod's socket answered /alive before the first message: ${alive}; asked to turn on mods: ${ASKED_TO_ENABLE.test(firstScreen)}; send-agent message ${id} arrived as ${turns.length} mod turn(s), answered ${ANSWER}: ${answer}, message-status ${status}`,
    };
  } finally {
    await court.close();
  }
}
