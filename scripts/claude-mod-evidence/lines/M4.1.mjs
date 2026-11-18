import { modStoppedAnswering } from "./mod-stopped-answering.mjs";

export async function check(harness) {
  const outcome = await modStoppedAnswering(harness, "m41");
  const pass = outcome.secondStatus === "delivered" && outcome.fallbackSeconds < 30 && !outcome.answeringWhileStopped && outcome.lines.length === 1 && outcome.lines[0].includes('"agent-m41"') && outcome.typedShown === 1 && outcome.secondModTurns === 0;
  return {
    verdict: pass ? "PASS" : "FAIL",
    observed: `${outcome.summary}; a helper that took the request but never answered is withdrawn by deliverThroughExtension's own wait (test/claude-mod-routing.test.ts)`,
  };
}
