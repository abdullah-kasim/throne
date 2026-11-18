import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openIsolatedCourt, recordModAgent } from "../isolated-court.mjs";
import { fallbackLines, launchArgv, waitForAnswering, waitForSilence } from "./court-agent.mjs";
import { answered, MOD_FOLDER, startModAgent, waitFor } from "./m3-mod-agent.mjs";
import { deliveredByMod, restartAndRecheck, waitForTurns } from "./flow.mjs";

const AGENT_READY_LIMIT_MS = 60_000;

function modArguments(folder) {
  return ["--plugin-dir", folder, "--setting-sources", "local", "--model", "haiku"];
}

async function restartClaude(harness, agent, folder) {
  const running = await launchArgv(agent.pane, harness.repo);
  if (running) process.kill(running.pid, "SIGTERM");
  await waitFor(async () => (await launchArgv(agent.pane, harness.repo)) === undefined, 30_000);
  await harness.herdr("agent", "start", agent.name, "--kind", "claude", "--pane", agent.pane, "--timeout", String(AGENT_READY_LIMIT_MS), "--", ...modArguments(folder)).catch(() => undefined);
  await sleep(5000);
  await harness.waitForComposer(agent.name, agent.pane);
  return (await launchArgv(agent.pane, harness.repo)) !== undefined;
}

async function sendAndCount(harness, court, agent, token) {
  const id = await court.sendAgent(agent.name, `Message ${token}. Reply with only the word ok.`);
  const status = await court.waitForStatus(id, "delivered", 90_000);
  await waitForTurns(harness, [token], 60_000);
  await sleep(5000);
  return { id, token, status, ...(await deliveredByMod(harness, token)) };
}

export async function check(harness) {
  const copy = path.join(harness.root, "mod-copy");
  await cp(MOD_FOLDER, copy, { recursive: true });
  const agent = await startModAgent(harness, "g5", copy);
  await agent.submitTyped("Reply with only the word primed.");
  if (!(await answered(agent, "primed"))) throw new Error("g5 never answered its first typed turn");
  await recordModAgent(harness, agent);
  const court = await openIsolatedCourt(harness);
  try {
    await waitForAnswering(agent);
    const before = await sendAndCount(harness, court, agent, "G5-BEFORE");
    await rm(copy, { recursive: true, force: true });
    const silent = await waitForSilence(agent);
    const linesBefore = (await fallbackLines(court, agent.name)).length;
    const deleted = await sendAndCount(harness, court, agent, "G5-DELETED");
    const reasons = (await fallbackLines(court, agent.name)).slice(linesBefore);
    await cp(MOD_FOLDER, copy, { recursive: true });
    const restarted = await restartClaude(harness, agent, copy);
    const alive = await waitForAnswering(agent);
    const restored = await sendAndCount(harness, court, agent, "G5-RESTORED");
    await harness.saveText("g5-after-restore", await agent.screen());
    const recheck = await restartAndRecheck(harness, court, [before, deleted, restored]);
    const pass = before.count === 1 && before.byMod === 1 && deleted.status === "delivered" && deleted.count === 1 && deleted.byMod === 0 && reasons.length === 1 && restarted && alive && restored.count === 1 && restored.byMod === 1 && recheck.holds;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `a Claude agent launched with a copy of the mod and recorded claude_mod true; message ${before.id} arrived ${before.count} time(s), ${before.byMod} by the mod; the mod copy was deleted from disk with the agent live and its socket stopped answering: ${silent}; message ${deleted.id} was ${deleted.status}, arrived ${deleted.count} time(s), ${deleted.byMod} by the mod, with ${reasons.length} logged reason(s): ${reasons.join(" | ").trim() || "none"}; the mod was restored and the agent restarted with it (running again with the mod: ${restarted}, socket answering: ${Boolean(alive)}); message ${restored.id} was ${restored.status}, arrived ${restored.count} time(s), ${restored.byMod} by the mod; ${recheck.summary}`,
    };
  } finally {
    await court.close();
  }
}
