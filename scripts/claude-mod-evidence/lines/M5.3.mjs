import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { DELIVER_PATH } from "../../../extensions/shared/agent-delivery-contract.ts";
import { deliveredTurns, deliver, startModAgent, validateMod } from "./m3-mod-agent.mjs";

const OWN_CALLS = ["process.spawn", "http.fetch", "env.get", "clock.sleep", "prompt.read", "prompt.submit", "command.run"];

function postRaw(socketPath, body) {
  return new Promise((resolve) => {
    const outgoing = request({ socketPath, method: "POST", path: DELIVER_PATH, headers: { "content-type": "application/json" } }, (incoming) => {
      const pieces = [];
      incoming.on("data", (piece) => pieces.push(piece));
      incoming.on("end", () => resolve(Buffer.concat(pieces).toString("utf8")));
    });
    outgoing.on("error", (error) => resolve(`no answer: ${error.message}`));
    outgoing.end(body);
  });
}

function refused(answer) {
  try {
    return JSON.parse(answer).status === "refused";
  } catch {
    return false;
  }
}

export async function check(harness) {
  const validation = await validateMod();
  await harness.saveText("validate", validation);
  const calls = validation.split("\n").find((line) => line.includes(" calls:")) ?? "";
  const modCalls = [...calls.matchAll(/\$\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`);
  const onlyOwnCalls = modCalls.every((call) => OWN_CALLS.includes(call));
  const agent = await startModAgent(harness, "own");
  await deliver(harness, agent, "Evidence said: reply with only the word ok.");
  const foreign = await postRaw(agent.socket, JSON.stringify({ id: "message-foreign-1", pane: "w9:pOTHER", text: "Evidence said: not for you", waitMs: 5000 }));
  const forged = await postRaw(agent.socket, JSON.stringify({ id: "message-forged-1", text: "Evidence said: forged recipient", waitMs: 5000 }));
  await sleep(10_000);
  const turns = await deliveredTurns(harness);
  const strays = turns.filter((turn) => /not for you|forged recipient/.test(turn.text)).length;
  return {
    verdict: onlyOwnCalls && refused(foreign) && refused(forged) && strays === 0 && turns.length === 1 ? "PASS" : "FAIL",
    observed: `validate lists the mod's calls: ${modCalls.join(", ")} (it spawns its helper and reaches it only over the socket named by THRONE_DELIVERY_SOCKET); a request on its socket addressed to another pane was answered: ${foreign}; a request on its socket naming no pane was answered: ${forged}; stray turns ${strays}; own delivered turns ${turns.length}`,
  };
}
