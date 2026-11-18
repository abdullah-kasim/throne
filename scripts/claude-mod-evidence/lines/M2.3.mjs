import { modStoppedAnswering } from "./mod-stopped-answering.mjs";

export async function check(harness) {
  const outcome = await modStoppedAnswering(harness, "m23");
  const pass = outcome.record.claude_mod === true && outcome.firstModTurns === 1 && outcome.secondModTurns === 0 && outcome.typedShown === 1 && outcome.lines.length === 1;
  return {
    verdict: pass ? "PASS" : "FAIL",
    observed: `delivery chose from the record and the socket answering /alive: ${outcome.summary}; the false record is M4.2's launch from a tree whose mod does not fit, spawn.json claude_mod false`,
  };
}
