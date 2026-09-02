// Observed twice inside one hour on 2026-08-25: an agent composing
// `send-agent <name> "…prose…"` in bash hands the prose to the SHELL first,
// and the shell evaluates whatever substitution syntax the prose contains. A
// Stager's message lost three phrases to backtick expansion. shadow-olsp-04's
// message contained a substitution the shell RAN, which re-launched a probe
// and overwrote that probe's own evidence log.
//
// send-agent cannot detect this — by the time argv arrives the substitution
// has already happened and the side effect has already run. So the fix is an
// input path that never passes prose through shell quoting at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSendAgentInput } from "../src/send-agent/send-agent-input.ts";
import { readPromptFile } from "../src/send-agent/prompt-file.ts";

// Exactly the shapes that caused both incidents.
const HOSTILE = [
  "the gate reads `noLaunchableWork`, not the prose",
  "re-run $(./run-word-remoteapp-probe.sh) to reproduce",
  'a "quoted" $HOME with ${BRACES} and a \\backslash',
].join("\n");

test("--prompt-file parses to a path and leaves the prompt for the command layer", () => {
  const input = parseSendAgentInput(["Regent", "--prompt-file", "/tmp/msg.txt"]);
  assert.equal(input.promptFile, "/tmp/msg.txt");
  assert.equal(input.prompt, "");
  // canonicalIdentityName lowercases; asserted so the flag is proven not to
  // disturb ordinary recipient resolution.
  assert.equal(input.recipientName, "regent");
});

test("--prompt-file - is accepted as stdin despite looking like a flag", () => {
  const input = parseSendAgentInput(["Regent", "--prompt-file", "-"]);
  assert.equal(input.promptFile, "-");
});

test("a prompt argument AND --prompt-file together is refused, not silently resolved", () => {
  assert.throws(
    () => parseSendAgentInput(["Regent", "hello", "--prompt-file", "/tmp/m.txt"]),
    /not both/,
  );
});

test("--prompt-file with no value is refused", () => {
  assert.throws(
    () => parseSendAgentInput(["Regent", "--prompt-file"]),
    /needs a non-empty path/,
  );
  assert.throws(
    () => parseSendAgentInput(["Regent", "--prompt-file", "--direct"]),
    /needs a non-empty path/,
  );
});

test("a bare prompt argument still works — the old path is not broken", () => {
  const input = parseSendAgentInput(["Regent", "hello", "there"]);
  assert.equal(input.prompt, "hello there");
  assert.equal(input.promptFile, undefined);
});

test("no prompt and no --prompt-file is still refused", () => {
  assert.throws(() => parseSendAgentInput(["Regent"]), /missing required prompt/);
});

test("a file's contents survive byte for byte, substitutions included", async () => {
  const dir = await mkdtemp(join(tmpdir(), "send-agent-prompt-"));
  try {
    const path = join(dir, "msg.txt");
    // Trailing newline as every editor and heredoc writes one.
    await writeFile(path, `${HOSTILE}\n`, "utf8");
    const prompt = await readPromptFile(path);
    assert.equal(prompt, HOSTILE, "the message must arrive exactly as written");
    assert.match(prompt, /`noLaunchableWork`/);
    assert.match(prompt, /\$\(\.\/run-word-remoteapp-probe\.sh\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stdin carries the same bytes, which is what makes a quoted heredoc safe", async () => {
  const prompt = await readPromptFile("-", async () => `${HOSTILE}\n`);
  assert.equal(prompt, HOSTILE);
});

test("only trailing newlines are trimmed; interior whitespace is the sender's", async () => {
  const prompt = await readPromptFile("-", async () => "a\n\n  indented\n\n\n");
  assert.equal(prompt, "a\n\n  indented");
});

test("an empty or unreadable prompt file refuses loudly and sends nothing", async () => {
  // Silently sending an empty message would be worse than the mangling this
  // replaces: mangled text is at least visibly wrong to its reader.
  await assert.rejects(
    readPromptFile("-", async () => "   \n"),
    /read an empty message from stdin; nothing was sent/,
  );
  await assert.rejects(
    readPromptFile(join(tmpdir(), "definitely-not-a-real-send-agent-file")),
    /could not be read.*Nothing was sent/s,
  );
});

// --- A guessed flag name must not become the message ---

test("a near-miss file flag is refused, naming the real one", () => {
  // Lived failure, 2026-08-25: the Regent sent `--message-file <path>`. Because
  // every unrecognised token joins the prompt, the recipient received that
  // literal string as the whole message and the real brief never left disk.
  // Silent at both ends — the sender saw a success, the recipient saw noise.
  for (const guess of [
    "--message-file",
    "--msg-file",
    "--body-file",
    "--input-file",
    "--from-file",
    "--text-file",
    "--file",
  ]) {
    assert.throws(
      () => parseSendAgentInput(["Regent", guess, "/tmp/brief.txt"]),
      new RegExp(`${guess} is not a flag.*--prompt-file`, "s"),
      `${guess} must be refused, not swallowed into the message`,
    );
  }
});

test("the refusal explains the silence, because the failure is invisible otherwise", () => {
  assert.throws(
    () => parseSendAgentInput(["Regent", "--message-file", "/tmp/x.txt"]),
    /becomes part of the MESSAGE/,
  );
});

test("ordinary prose containing a double dash is still a message, not a flag", () => {
  // The fix must not turn every "--" in a sentence into a parse error; only
  // the specific near-miss names are refused.
  const input = parseSendAgentInput([
    "Regent",
    "run it with --force and report back",
  ]);
  assert.equal(input.prompt, "run it with --force and report back");
});

// --- The SHAPE of the mistake, not just its spelling ---

test("any unknown --flag followed by a path is refused, whatever it is called", () => {
  // The seven named spellings caught the guesses we thought of. This catches
  // the mistake itself. The Regent produced it six times across three
  // recipients in one evening; each was caught only because the recipient
  // recognised a path and read the file off disk unprompted.
  for (const flag of [
    "--brief",              // not in the named set
    "--attach",             // not in the named set
    "--send-file",          // not in the named set
    "--totally-made-up",    // nothing could have predicted this
  ]) {
    assert.throws(
      () => parseSendAgentInput(["Regent", flag, "/home/example/tmp/brief.txt"]),
      /that is an unrecognised flag and its argument, not a message/,
      `"${flag} <path>" must never be delivered as a message`,
    );
  }
  // A spelling that IS in the named set is caught by the earlier, more
  // specific check — which gives the better message of the two. Either way it
  // is refused and either way it names --prompt-file; what must never happen
  // is delivery.
  assert.throws(
    () =>
      parseSendAgentInput([
        "Regent",
        "--message-file",
        "/home/example/tmp/brief.txt",
      ]),
    /--prompt-file/,
  );
});

test("the refusal names the file the sender actually meant to send", () => {
  assert.throws(
    () => parseSendAgentInput(["Regent", "--brief", "/tmp/plan.md"]),
    /send the contents of \/tmp\/plan\.md, the flag is --prompt-file/,
  );
});

test("a tilde path is caught too — it is the same mistake", () => {
  // Unnamed flag, so this exercises the shape check rather than the spelling
  // check; ~ is as much a path as / and the same silent delivery follows.
  assert.throws(
    () => parseSendAgentInput(["Regent", "--brief-file", "~/tmp/brief.txt"]),
    /unrecognised flag and its argument/,
  );
});

test("a real two-word message is NOT refused just for having two words", () => {
  // The check must be narrow enough that ordinary short messages survive.
  assert.equal(
    parseSendAgentInput(["Regent", "ship", "it"]).prompt,
    "ship it",
  );
  // A flag-shaped first word with a non-path second word is still a message.
  assert.equal(
    parseSendAgentInput(["Regent", "--force", "worked"]).prompt,
    "--force worked",
  );
  // A path on its own is a message; only flag-then-path is the mistake.
  assert.equal(
    parseSendAgentInput(["Regent", "check", "/etc/hosts"]).prompt,
    "check /etc/hosts",
  );
});

// --- The residue: warn where refusing would cost more than it saves ---

import { suspectedFlagPrefixWarning } from "../src/send-agent/send-agent-input.ts";

test("a message beginning with an unknown flag-shaped token warns, and still sends", () => {
  // The Regent's real probe: `--validate-only "check /etc/hosts"` expecting a
  // dry run. No such flag, second token not path-shaped, so it was delivered
  // as prose with nobody told.
  const warning = suspectedFlagPrefixWarning("--validate-only check /etc/hosts");
  assert.match(warning ?? "", /BEGINS with "--validate-only"/);
  assert.match(warning ?? "", /sent as ordinary message text/);
  assert.match(warning ?? "", /--prompt-file/);
  // The distinction that makes this a warning and not a refusal:
  assert.match(warning ?? "", /this is a warning, not a refusal/);
});

test("an ordinary sentence that happens to start with a flag is NOT warned about twice over", () => {
  // It still warns — it cannot tell prose from a typo — but it must never
  // refuse, because this is a real sentence in this court.
  const warning = suspectedFlagPrefixWarning(
    "--force cascades through live children, so avoid it",
  );
  assert.notEqual(warning, undefined, "it warns");
  assert.doesNotMatch(warning ?? "", /refus(e|ed|ing)\b(?!, )/);
});

test("a normal message produces no warning at all", () => {
  for (const prompt of [
    "ship it",
    "check /etc/hosts",
    "the --force flag is dangerous",
    "merged as c007d184",
  ]) {
    assert.equal(
      suspectedFlagPrefixWarning(prompt),
      undefined,
      `"${prompt}" must not warn`,
    );
  }
});

test("a real flag never reaches the warning, because it was parsed as a flag", () => {
  // --direct is a genuine flag; it is consumed by the parser and never lands
  // in the prompt, so the warning has nothing to fire on.
  const input = parseSendAgentInput(["Regent", "--direct", "hello"]);
  assert.equal(input.prompt, "hello");
  assert.equal(suspectedFlagPrefixWarning(input.prompt), undefined);
});
