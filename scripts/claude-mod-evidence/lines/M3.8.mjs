import { deliveredTurns, deliver, frameHolds, saveJson, startModAgent, waitFor } from "./m3-mod-agent.mjs";

const LONG_LENGTH = 20_000;
const TRANSCRIPT_LIMIT_MS = 30_000;

function longMessage() {
  const unit = "long message 0123456789 abcdefghij ";
  return `Evidence said: reply with only the word ok. ${unit.repeat(Math.ceil(LONG_LENGTH / unit.length))}`.slice(0, LONG_LENGTH);
}

const AWKWARD = 'Evidence said: reply with only the word ok. "double" \'single\' `back` \\ \\\\ \\n literal\nreal newline\n\ttab 🎉👩‍💻 ünïcödé';

export async function check(harness) {
  const agent = await startModAgent(harness, "bytes");
  const long = longMessage();
  const longOutcome = await deliver(harness, agent, long);
  const awkwardOutcome = await deliver(harness, agent, AWKWARD);
  const bothRecorded = (turns) => turns.some((turn) => frameHolds(turn, long)) && turns.some((turn) => frameHolds(turn, AWKWARD));
  await waitFor(async () => bothRecorded(await deliveredTurns(harness)), TRANSCRIPT_LIMIT_MS);
  const turns = await deliveredTurns(harness);
  await saveJson(harness, "delivered-turns", turns);
  const longExact = turns.some((turn) => frameHolds(turn, long));
  const awkwardExact = turns.some((turn) => frameHolds(turn, AWKWARD));
  return {
    verdict: longOutcome.kind === "delivered" && awkwardOutcome.kind === "delivered" && longExact && awkwardExact && long.length === LONG_LENGTH ? "PASS" : "FAIL",
    observed: `20,000-character message ${longOutcome.kind}, byte for byte in the transcript: ${longExact}; quotes/backslashes/newlines/emoji message ${awkwardOutcome.kind}, byte for byte: ${awkwardExact}`,
  };
}
