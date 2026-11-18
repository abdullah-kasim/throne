import { openIsolatedCourt } from "../isolated-court.mjs";
import { agentAlive } from "../../../src/herdr/delivery-request-client.ts";
import { launchArgv, screenShows } from "./court-agent.mjs";

const HARNESSES = [
  { label: "codex", model: "gpt-5.4-mini", signedOut: "Sign in with ChatGPT" },
  { label: "pi", model: "flash", signedOut: "No API key", refusedWithout: "no deepseek provider account is configured" },
];

async function launchOnce(harness, court, { label, model, signedOut }) {
  const agent = await court.createAgent(`m51-${label}`, { model });
  const process = await launchArgv(agent.pane, harness.repo);
  const record = await court.spawnRecord(agent.name);
  const message = `reply with the single word received-m51-${label}`;
  const id = await court.sendAgent(agent.name, message);
  const status = await court.waitForStatus(id, "delivered", 90_000);
  const shown = await screenShows(agent, message, 30_000);
  const screen = await agent.screen();
  await harness.saveText(`m51-${label}-screen`, screen);
  const takenByMod = (await agentAlive(record.delivery_socket, agent.pane))?.harness === "claude";
  const argv = (process?.argv ?? []).join(" ");
  return { argv, record, status, shown, signedOut: screen.includes(signedOut), takenByMod, id };
}

async function judge(harness, court, entry) {
  const launch = launchOnce(harness, court, entry);
  const outcome = entry.refusedWithout ? await launch.catch((error) => (String(error.message).includes(entry.refusedWithout) ? String(error.message) : Promise.reject(error))) : await launch;
  if (typeof outcome === "string") return { verdict: "NOT VERIFIED", observed: `${entry.label} (${entry.model}): the isolated court has no provider account, and the run never copies the person's accounts, so create-agent refused before any launch: ${outcome.split("\n")[0]}` };
  const launchHolds = outcome.argv !== "" && !outcome.argv.includes("--plugin-dir") && outcome.record.claude_mod === undefined && !outcome.takenByMod;
  const messaged = outcome.status === "delivered" && outcome.shown;
  const cannotTakeTurn = outcome.signedOut || !outcome.shown;
  const verdict = !launchHolds ? "FAIL" : messaged ? "PASS" : cannotTakeTurn ? "NOT VERIFIED" : "FAIL";
  return {
    verdict,
    observed: `${entry.label} (${entry.model}) by real create-agent: argv carries --plugin-dir ${outcome.argv.includes("--plugin-dir")} (${outcome.argv}); spawn.json claude_mod ${outcome.record.claude_mod}; send-agent ${outcome.id}: ${outcome.status}, typed into the pane ${outcome.shown}; its socket answers as a Claude mod ${outcome.takenByMod}${verdict === "NOT VERIFIED" ? `; the host's ${entry.label} cannot take a turn here (signed out or never answered; screen saved), so typed delivery to it could not be observed` : ""}`,
  };
}

export async function check(harness) {
  const court = await openIsolatedCourt(harness);
  const results = [];
  try {
    for (const entry of HARNESSES) results.push(await judge(harness, court, entry));
  } finally {
    await court.close();
  }
  const verdicts = results.map((result) => result.verdict);
  const verdict = verdicts.includes("FAIL") ? "FAIL" : verdicts.includes("NOT VERIFIED") ? "NOT VERIFIED" : "PASS";
  return { verdict, observed: results.map((result) => `${result.verdict}: ${result.observed}`).join(" || ") };
}
