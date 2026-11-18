import { mixedCourt } from "./mixed-court.mjs";

export async function check(harness) {
  const outcome = await mixedCourt(harness, { prefix: "g2" });
  const pass = outcome.delivered && outcome.records && outcome.once.length === 0 && outcome.wrongMethod.length === 0 && outcome.rightAgent && outcome.recheck.holds;
  return { verdict: pass ? "PASS" : "FAIL", observed: outcome.summary };
}
