import { setTimeout as sleep } from "node:timers/promises";
import { startModAgent, validateMod } from "./m3-mod-agent.mjs";

const VISIBLE_CALLS = /\$\.(ui|command|status|toast|band|pane|notify)\b/;

export async function check(harness) {
  const validation = await validateMod();
  await harness.saveText("validate", validation);
  const calls = validation.split("\n").filter((line) => line.includes(" calls:") || line.includes(" hooks:")).join("\n");
  const plain = await harness.startClaude({ name: "plain", claudeArguments: ["--setting-sources", "local", "--model", "haiku"] });
  const modded = await startModAgent(harness, "modded");
  await sleep(3000);
  const footer = (screen) => screen.split("\n").slice(screen.split("\n").findLastIndex((line) => line.startsWith("❯"))).join("\n").replace(/\s+$/, "");
  const moddedFooter = footer(await modded.screen());
  await plain.saveScreen("idle");
  await modded.saveScreen("idle");
  await modded.putDraft("/throne");
  await sleep(1500);
  const commands = await modded.screen();
  await modded.saveScreen("slash-throne");
  await modded.clearDraft();
  const noVisibleCall = !VISIBLE_CALLS.test(calls);
  const footerClean = !/throne|delivery/i.test(moddedFooter);
  const noCommand = !/\/throne-delivery|throne-delivery:/.test(commands.split("❯").at(-1) ?? "");
  return {
    verdict: noVisibleCall && footerClean && noCommand ? "PASS" : "FAIL",
    observed: `validate lists the mod's hooks and calls as:\n${calls}\nno display, command, status or toast call: ${noVisibleCall}; the modded agent's composer and footer name nothing of the mod: ${footerClean} (plain and modded footers saved side by side; they differ only by Claude Code's own rotating hint, updater and usage notices); typing /throne offers no command of the mod: ${noCommand}`,
  };
}
