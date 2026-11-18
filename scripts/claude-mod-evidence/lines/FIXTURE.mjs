import { setTimeout as sleep } from "node:timers/promises";

const KNOWN_DRAFT = "fixture draft 7f3a";
const HOLD_SECONDS = 20;
const BUSY_MARKER = "esc to interrupt";

export async function check(harness) {
  const agent = await harness.startClaude({
    name: "fixture",
    claudeArguments: ["--setting-sources", "local", "--model", "haiku"],
  });
  await agent.putDraft(KNOWN_DRAFT);
  await sleep(1000);
  const withDraft = await agent.screen();
  await agent.saveScreen("draft");
  const draftShown = withDraft.includes(KNOWN_DRAFT);
  await agent.clearDraft();
  await sleep(500);
  await agent.holdTurn(HOLD_SECONDS);
  await sleep(8000);
  const midTurn = await agent.screen();
  await agent.saveScreen("mid-turn");
  const held = midTurn.includes("hold-turn.py") && midTurn.includes(BUSY_MARKER);
  return {
    verdict: draftShown && held ? "PASS" : "FAIL",
    observed: `draft in composer: ${draftShown}; agent still running hold-turn.py 8s into a ${HOLD_SECONDS}s hold: ${held}`,
  };
}
