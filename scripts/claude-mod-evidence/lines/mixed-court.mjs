import { openIsolatedCourt } from "../isolated-court.mjs";
import { waitForAnswering } from "./court-agent.mjs";
import { saveJson } from "./m3-mod-agent.mjs";
import { throneWithUnfitMod } from "./unfit-mod-throne.mjs";
import { deliveredByMod, restartAndRecheck, waitForEveryStatus, waitForTurns } from "./flow.mjs";

const COUNT = 20;

export async function mixedCourt(harness, { prefix }) {
  const court = await openIsolatedCourt(harness);
  try {
    const typedAgent = await court.createAgent(`${prefix}-typed`, { root: await throneWithUnfitMod(harness) });
    const modAgent = await court.createAgent(`${prefix}-mod`);
    const typedRecord = await court.spawnRecord(typedAgent.name);
    const modRecord = await court.spawnRecord(modAgent.name);
    await waitForAnswering(modAgent);
    const sent = [];
    for (let index = 1; index <= COUNT; index++) {
      const recipient = index % 2 === 1 ? modAgent : typedAgent;
      const token = `${prefix.toUpperCase()}-${index}-${recipient === modAgent ? "MOD" : "TYPED"}`;
      const id = await court.sendAgent(recipient.name, `Message ${token}. Reply with only the word ok.`);
      sent.push({ id, token, recipient: recipient.name, expectMod: recipient === modAgent });
    }
    const statuses = await waitForEveryStatus(court, sent.map((message) => message.id), 180_000);
    await waitForTurns(harness, sent.map((message) => message.token), 120_000);
    const arrivals = [];
    for (const message of sent) arrivals.push({ ...message, ...(await deliveredByMod(harness, message.token)) });
    await saveJson(harness, `${prefix}-arrivals`, arrivals);
    const sessionsOf = (name) => new Set(arrivals.filter((arrival) => arrival.recipient === name).flatMap((arrival) => arrival.sessions));
    const modSessions = sessionsOf(modAgent.name);
    const typedSessions = sessionsOf(typedAgent.name);
    const rightAgent = modSessions.size === 1 && typedSessions.size === 1 && ![...modSessions].some((session) => typedSessions.has(session));
    const once = arrivals.filter((arrival) => arrival.count !== 1);
    const wrongMethod = arrivals.filter((arrival) => arrival.count === 1 && (arrival.byMod === 1) !== arrival.expectMod);
    const recheck = await restartAndRecheck(harness, court, sent);
    return {
      delivered: statuses.every((status) => status === "delivered"),
      records: typedRecord.claude_mod === false && modRecord.claude_mod === true,
      once,
      wrongMethod,
      rightAgent,
      recheck,
      summary: `real create-agent ${typedAgent.name} from a throne tree whose mod does not fit (spawn.json claude_mod ${typedRecord.claude_mod}) and ${modAgent.name} with the mod (spawn.json claude_mod ${modRecord.claude_mod}); ${COUNT} alternating send-agent messages; message-status: ${statuses.filter((status) => status === "delivered").length}/${COUNT} delivered; arrived other than once: ${once.map((arrival) => `${arrival.token} x${arrival.count}`).join(", ") || "none"}; arrived by the other method: ${wrongMethod.map((arrival) => arrival.token).join(", ") || "none"}; each agent's messages sit in its own single transcript: ${rightAgent}; ${recheck.summary}`,
    };
  } finally {
    await court.close();
  }
}
