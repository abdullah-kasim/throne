import { openIsolatedCourt } from "../isolated-court.mjs";
import { waitForAnswering } from "./court-agent.mjs";
import { saveJson, waitFor } from "./m3-mod-agent.mjs";
import { throneWithUnfitMod } from "./unfit-mod-throne.mjs";
import { deliveredByMod, turnsHolding, uncertainLines } from "./flow.mjs";

const COUNT = 30;
const RECEIPT_LIMIT_MS = 120_000;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function timePath(harness, court, agent, label) {
  const timings = [];
  for (let index = 1; index <= COUNT; index++) {
    const token = `T1-${label}-${index}`;
    const sentAt = Date.now();
    const id = await court.sendAgent(agent.name, `Message ${token}. Reply with only the word ok.`);
    const received = await waitFor(async () => (await turnsHolding(harness, token)).length > 0, RECEIPT_LIMIT_MS, 250);
    const seconds = received ? (Date.now() - sentAt) / 1000 : null;
    const status = await court.waitForStatus(id, "delivered", 30_000);
    timings.push({ id, token, seconds, status, ...(await deliveredByMod(harness, token)) });
  }
  return timings;
}

function figuresOf(timings, logText, name) {
  const seconds = timings.map((timing) => timing.seconds).filter((value) => value !== null);
  return {
    messages: timings.length,
    received: seconds.length,
    by_mod: timings.filter((timing) => timing.byMod === 1).length,
    median_seconds: seconds.length === 0 ? null : median(seconds),
    max_seconds: seconds.length === 0 ? null : Math.max(...seconds),
    uncertain: uncertainLines(logText, name).length + timings.filter((timing) => timing.status !== "delivered").length,
    per_message_seconds: timings.map((timing) => timing.seconds),
  };
}

export async function check(harness) {
  const court = await openIsolatedCourt(harness);
  try {
    const typedAgent = await court.createAgent("t1-typed", { root: await throneWithUnfitMod(harness) });
    const modAgent = await court.createAgent("t1-mod");
    await waitForAnswering(modAgent);
    const [modTimings, typedTimings] = await Promise.all([timePath(harness, court, modAgent, "MOD"), timePath(harness, court, typedAgent, "TYPED")]);
    await saveJson(harness, "t1-timings", { mod: modTimings, typed: typedTimings });
    const logText = await court.backendLogText();
    const figures = { mod: figuresOf(modTimings, logText, modAgent.name), typed: figuresOf(typedTimings, logText, typedAgent.name) };
    const complete = figures.mod.received === COUNT && figures.typed.received === COUNT && figures.mod.by_mod === COUNT && figures.typed.by_mod === 0;
    return {
      verdict: complete ? "PASS" : "FAIL",
      figures,
      observed: `${COUNT} messages to ${modAgent.name} (mod) and ${COUNT} to ${typedAgent.name} (typed keys), each sent after the last was received: mod received ${figures.mod.received} (${figures.mod.by_mod} by the mod), median ${figures.mod.median_seconds}s, max ${figures.mod.max_seconds}s, uncertain ${figures.mod.uncertain}; typed received ${figures.typed.received} (${figures.typed.by_mod} by the mod), median ${figures.typed.median_seconds}s, max ${figures.typed.max_seconds}s, uncertain ${figures.typed.uncertain}`,
    };
  } finally {
    await court.close();
  }
}
