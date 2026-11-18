export const SPEC_LINES = [
  { line: "M1.2", expected: "A config.user.ts that still names features.claudeModDelivery is refused by throne check-config naming the key, and check-config prints no feature line for it when the key is absent." },
  { line: "M2.1", expected: "A newly launched Claude agent has throne's mod loaded from the first turn and is never asked to turn on mods." },
  { line: "M2.3", expected: "spawn.json records whether the agent was launched with the mod; delivery chooses from that record and a live sign the mod answers." },
  { line: "M3.1", expected: "send-agent to an idle agent with the mod: it receives the message as a turn and answers; message-status says delivered." },
  { line: "M3.2", expected: "The received text carries the sender and message number in the typed path's wrapper." },
  { line: "M3.3", expected: "With a human draft in the composer the message waits; draft and cursor are unchanged; after the draft is submitted or cleared it is delivered once." },
  { line: "M3.4", expected: "A message sent mid-turn: the running turn finishes uninterrupted and the message is the next turn." },
  { line: "M3.5", expected: "Ten messages to agent A all reach A in order; none reaches B." },
  { line: "M3.6", expected: "During M3.1 to M3.5 throne types no keys into the pane and reads no pane history." },
  { line: "M3.7", expected: "Backend killed while the helper holds the request and before it answers, then restarted: the agent has the message exactly once." },
  { line: "M3.8", expected: "A 20,000 character message and one with quotes, backslashes, newlines and emoji each arrive byte for byte." },
  { line: "M4.1", expected: "Mod not answering: the request is withdrawn, delivery is by typed keys, one line names the agent and reason; exactly once." },
  { line: "M4.2", expected: "The mod fails claude plugin validate: agents launch without it, delivery is by typed keys, one clear line says it does not fit." },
  { line: "M5.1", expected: "Codex agents (and pi agents if on main) launch with no --plugin-dir and are messaged by typed keys exactly as before." },
  { line: "M5.2", expected: "The mod adds nothing the person sees: no pane, band, status entry, toast or command." },
  { line: "M5.3", expected: "The mod takes requests only on its own socket and only for its own pane." },
  { line: "G1", expected: "A Shadow created under a stand-in Alpha receives its tasking by the mod, adds one function with a test to a scratch repository, commits, reports DONE by throne send-agent, and is completed and reaped; the supervisor received exactly one DONE; after a backend restart nothing is delivered again." },
  { line: "G2", expected: "One Claude agent launched from a tree whose mod does not fit and one launched with the mod; twenty alternating messages each arrive once, by typed keys to the first and by the mod to the second, to the right agent; after a backend restart none is delivered again." },
  { line: "G4", expected: "A draft sits in the composer two minutes while five messages queue; the draft is unchanged throughout; after it is submitted the five arrive in order; after a backend restart none is delivered again." },
  { line: "G5", expected: "The mod is deleted from disk while its agent is live; the next message arrives by typed keys with one logged reason; the agent restarted with the mod restored takes mod delivery again; after a backend restart none is delivered again." },
  { line: "T1", expected: "Thirty messages by the mod to one agent and thirty by typed keys to another: seconds from send to receipt per message, median and max per path, and the count of deliveries logged as assumed filled or otherwise uncertain on each path." },
  { line: "FIXTURE", expected: "The fixture puts a known draft in a real Claude Code composer and holds the agent mid-turn with a long-running command." },
];

export function selectSpecLines({ line, group }) {
  const selected = SPEC_LINES.filter((entry) => entry.line === line || group === "all" || (group !== undefined && entry.line.startsWith(group)));
  if (selected.length === 0) {
    throw new Error(`claude-mod-evidence: no spec line matches ${line ? `--line ${line}` : `--group ${group}`}`);
  }
  return selected;
}
