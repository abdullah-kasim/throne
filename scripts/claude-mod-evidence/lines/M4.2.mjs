import { openIsolatedCourt } from "../isolated-court.mjs";
import { launchArgv, modTurnsHolding, screenShows, TYPED_PREFIX } from "./court-agent.mjs";
import { throneWithUnfitMod } from "./unfit-mod-throne.mjs";

export async function check(harness) {
  const root = await throneWithUnfitMod(harness);
  const court = await openIsolatedCourt(harness);
  try {
    const agent = await court.createAgent("m42", { root });
    const misfit = agent.output.split("\n").filter((line) => line.includes("does not fit this Claude Code version"));
    const process = await launchArgv(agent.pane, harness.repo);
    const record = await court.spawnRecord(agent.name);
    const ready = await screenShows(agent, "● ready", 120_000);
    await harness.saveText("m42-before-message", await agent.screen());
    const message = "reply with the single word received-m42";
    const id = await court.sendAgent(agent.name, message);
    const status = await court.waitForStatus(id, "delivered", 60_000);
    const shown = await screenShows(agent, `${TYPED_PREFIX}${message}`, 30_000);
    const turns = (await modTurnsHolding(harness, message)).length;
    await harness.saveText("m42-screen", await agent.screen());
    const pass = ready && misfit.length === 1 && misfit[0].includes(`"${agent.name}"`) && process !== undefined && !process.argv.includes("--plugin-dir") && record.claude_mod === false && status === "delivered" && shown && turns === 0;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `a throne tree whose extensions/claude hooks module has no register export; real create-agent from that tree printed ${misfit.length} misfit line(s): ${misfit.join(" ").trim()}; argv carries --plugin-dir: ${process?.argv.includes("--plugin-dir")}; spawn.json claude_mod ${record.claude_mod}; answered its opening prompt: ${ready}; send-agent message ${id} ${status}, typed into the pane: ${shown}, mod turns ${turns}`,
    };
  } finally {
    await court.close();
  }
}
