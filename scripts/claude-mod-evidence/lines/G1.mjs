import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { openIsolatedCourt } from "../isolated-court.mjs";
import { waitForAnswering } from "./court-agent.mjs";
import { saveJson, userTurns, waitFor } from "./m3-mod-agent.mjs";
import { courtThroneCommand, deliveredByMod, restartAndRecheck } from "./flow.mjs";

const run = promisify(execFile);
const DONE_TOKEN = "G1-DONE-7Q";
const WORK_LIMIT_MS = 600_000;

function tasking(throneCommand, supervisor, reportPath) {
  return [
    "G1-TASKING. You are a Shadow working in the current git repository.",
    "1. Add a file named double.mjs that exports a function double(n) returning n * 2.",
    "2. Add a file named double.test.mjs that imports it and checks double(3) is 6 with node:assert, then run it with: node double.test.mjs",
    "3. Commit both files with exactly: git add double.mjs double.test.mjs && git commit -m 'add double'",
    `4. Report once by running exactly: ${throneCommand} send-agent ${supervisor} "${DONE_TOKEN} double added and committed"`,
    `5. With your file-writing tool, not a shell command, write one line saying what you did to ${reportPath}`,
    `6. Then run: ${throneCommand} my-state reapable completed`,
    "Then stop.",
  ].join("\n");
}

export async function check(harness) {
  const court = await openIsolatedCourt(harness);
  try {
    const throneCommand = await courtThroneCommand(harness, court);
    const shadow = await court.createAgent("g1-shadow");
    const record = await court.spawnRecord(shadow.name);
    await waitForAnswering(shadow);
    const taskingText = tasking(throneCommand, court.sender.name, path.join(harness.dataHome, "data", shadow.name, "REPORT.md"));
    const id = await court.sendAgent(shadow.name, taskingText);
    const status = await court.waitForStatus(id, "delivered", 120_000);
    const doneTurns = async () => (await userTurns(harness)).filter((turn) => turn.text.includes(`${DONE_TOKEN} double`) && !turn.text.includes("G1-TASKING"));
    await waitFor(async () => (await doneTurns()).length > 0, WORK_LIMIT_MS, 5000);
    await harness.saveText("g1-shadow-screen", await shadow.screen());
    const tasked = await deliveredByMod(harness, "G1-TASKING");
    const log = (await run("git", ["log", "--oneline"], { cwd: harness.repo })).stdout.trim();
    const test = await run("node", ["double.test.mjs"], { cwd: harness.repo }).then(() => true, () => false);
    await waitFor(async () => !JSON.parse(await harness.herdr("agent", "list")).result.agents.some((agent) => agent.name === shadow.name && agent.agent_status === "working"), 60_000, 2000);
    const completed = await court.throne(["complete-agent", shadow.name]);
    const listed = JSON.parse(await harness.herdr("agent", "list")).result.agents.some((agent) => agent.name === shadow.name);
    const done = await doneTurns();
    await saveJson(harness, "g1-done-turns", done);
    const recheck = await restartAndRecheck(harness, court, [{ id, token: "G1-TASKING" }]);
    const doneAfter = (await doneTurns()).length;
    const pass = record.claude_mod === true && status === "delivered" && tasked.count === 1 && tasked.byMod === 1 && log.includes("add double") && test && completed.code === 0 && !listed && done.length === 1 && doneAfter === 1 && recheck.holds;
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `real create-agent ${shadow.name} under the stand-in supervisor ${court.sender.name}, spawn.json claude_mod ${record.claude_mod}; tasking ${id} ${status}, arrived ${tasked.count} time(s), ${tasked.byMod} by the mod; scratch repository log: ${log.replace(/\n/gu, " / ")}; double.test.mjs passes: ${test}; complete-agent exited ${completed.code} and herdr still lists the Shadow: ${listed}; DONE turns the supervisor received: ${done.length} (after the backend restart: ${doneAfter}); ${recheck.summary}`,
    };
  } finally {
    await court.close();
  }
}
