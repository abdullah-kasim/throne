import { errorText } from "../shared-policy/error-text.ts";
import { canonicalIdentityName } from "../shared-identity/shared-identity.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const SENDER_NAME_FLAG = "--sender-name";
const KEY_FLAG = "--key";
const CLEAR_BLOCKED_FLAG = "--clear-blocked";
const DIRECT_FLAG = "--direct";
const AT_FLAG = "--at";
const AFTER_FLAG = "--after";
const PROMPT_FILE_FLAG = "--prompt-file";

/**
 * Names a caller plausibly reaches for when they mean `--prompt-file`.
 *
 * WHY THIS IS A REFUSAL AND NOT AN ALIAS: an unrecognised token is not
 * rejected by this parser — every non-flag argument joins the PROMPT. So a
 * caller who guesses wrong does not get an error, they get their flag and
 * their path delivered as the literal body of the message, and the real
 * message never leaves the disk. That happened on 2026-08-25: the Regent sent
 * `--message-file /path/to/brief.txt`, the recipient received exactly that
 * string, and nobody noticed until the recipient went looking for the file by
 * hand. The failure is silent at both ends, which is what makes it worth a
 * named refusal rather than a shrug.
 *
 * Accepting them as aliases would also work, and is deliberately not done:
 * one name for one thing, and a caller told the right name once uses it
 * thereafter. The cost of the refusal is a single retry; the cost of the
 * silence was an entire brief.
 */
const MISTAKEN_PROMPT_FILE_FLAGS: ReadonlySet<string> = new Set([
  "--message-file",
  "--msg-file",
  "--body-file",
  "--input-file",
  "--from-file",
  "--text-file",
  "--file",
]);

/**
 * THE HAZARD THIS FLAG EXISTS FOR, observed twice in one hour on 2026-08-25:
 * an agent composing `send-agent <name> "…prose…"` in bash hands the prose to
 * the SHELL first, and the shell evaluates whatever substitution syntax the
 * prose happens to contain. A Stager's message lost three phrases to backtick
 * expansion. Worse, in the same hour, shadow-olsp-04's message contained a
 * substitution the shell RAN — it re-launched a probe and overwrote that
 * probe's own evidence log. A message cost a garbled sentence; the other cost
 * an experiment.
 *
 * send-agent cannot defend against this from the inside and it is important
 * to say why, so nobody later "hardens the parser" instead: by the time argv
 * reaches this function the substitution has already happened. The original
 * characters are gone, the side effect has already run, and the received text
 * is indistinguishable from text a caller meant to send. There is nothing to
 * detect.
 *
 * So the fix is an input path that never passes prose through shell quoting.
 * `--prompt-file <path>` reads the message from a file, and `--prompt-file -`
 * reads it from stdin, which makes a quoted heredoc the safe idiom:
 *
 *     throne send-agent Regent --prompt-file - <<'EOF'
 *     Anything at all: `backticks`, $(substitutions), "quotes", $VARS.
 *     EOF
 *
 * The quoted `'EOF'` delimiter is what disables every expansion. An unquoted
 * heredoc still expands, so the quotes are load-bearing rather than style.
 */

const USAGE =
  "Usage: ./bin/throne-cli send-agent <recipient-name> <prompt...> " +
  `[${SENDER_NAME_FLAG} <name>]\n` +
  `[${KEY_FLAG} <key>]\n` +
  `[${CLEAR_BLOCKED_FLAG}]\n` +
  `[${DIRECT_FLAG}]\n` +
  `[${AT_FLAG} <RFC3339-with-timezone> | ${AFTER_FLAG} <duration>]\n` +
  `[${PROMPT_FILE_FLAG} <path> | ${PROMPT_FILE_FLAG} - (stdin)]\n` +
  `${CLEAR_BLOCKED_FLAG} explicitly clears the recipient's durable blocked ` +
  "marker as part of this send, independent of the message content.\n" +
  "By default send-agent enqueues one durable work item and exits " +
  "immediately, printing the message id (exit 0); message-status <id> polls " +
  "for delivery. A pre-write refusal (e.g. unknown recipient) still fails " +
  "clean and synchronously before any queue write. If the work server's " +
  "heartbeat is stale or absent, the enqueue still succeeds and still exits " +
  "0, but an unmistakable degraded-court warning is written to stderr in " +
  "the same call.\n" +
  `${DIRECT_FLAG} bypasses the queue entirely and delivers synchronously ` +
  "through the platform primitive, `herdr agent prompt <target> <text> " +
  "--wait --timeout <ms>` — manual recovery for when the queue/server path " +
  "is confirmed broken. It owns the write and the Enter; the throne " +
  "resolves the recipient uniquely, attributes the sender, holds the " +
  "recipient pane lock (waiting for any resident draft to clear first — it " +
  "is never overwritten; the bounded wait times out typed not-sent), " +
  "flushes text found after acquisition before submitting the payload " +
  "once, backs large payloads to files, and maps the platform's typed " +
  "outcome to a typed not-sent/assumed-filled verdict.\n" +
  "Multi-line: pass real newlines in one quoted argument, e.g. $'L1\\nL2'.\n" +
  `${PROMPT_FILE_FLAG} reads the message from a file instead of argv, and ` +
  "is the SAFE way to send prose. A message written as a quoted shell " +
  "argument is evaluated by the shell first: backticks and $(...) inside it " +
  "are executed, which has both corrupted a message and re-run a command " +
  "that destroyed its own evidence log. Prefer a quoted heredoc, whose " +
  "delimiter quotes disable every expansion:\n" +
  `  throne send-agent <name> ${PROMPT_FILE_FLAG} - <<'EOF'\n` +
  "  ...message, any characters at all...\n" +
  "  EOF\n";

export interface ScheduledSendTiming {
  readonly dueAt: string;
  readonly dueAtMs: number;
}

export interface SendAgentInput {
  readonly recipientName: string;
  /** Empty when `promptFile` is set; the command layer reads the file and
   *  fills it. Parsing stays pure and does no I/O. */
  readonly prompt: string;
  /** Absolute or relative path to read the prompt from, or `-` for stdin. */
  readonly promptFile?: string;
  readonly senderName?: string;
  readonly key?: string;
  readonly clearBlocked: boolean;
  readonly direct: boolean;
  readonly scheduled?: ScheduledSendTiming;
}

export function sendAgentInputError(error: unknown): string {
  return `send-agent: ${errorText(error)}\n${renderEntranceRefusal({
    reason: "Entrance validation refused this send-agent invocation.",
    bypass: undefined,
    supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
  })}\n${USAGE}`;
}

/**
 * A message that BEGINS with a flag-shaped token, when that token is not a flag
 * this command knows.
 *
 * This is the residue the shape check deliberately leaves behind, and it is
 * warned about rather than refused. The Regent found it by running
 * `send-agent stager-floor --validate-only "check /etc/hosts"` expecting a dry
 * run: there is no such flag, the second token is not path-shaped, so the
 * message was delivered as the prose "--validate-only check /etc/hosts".
 *
 * REFUSING THIS WOULD EAT REAL MESSAGES. In this court "--force cascades
 * through live children" is an ordinary sentence, and it begins with a
 * flag-shaped token. The shape check earns its refusal because flag-then-path
 * is never prose; this pattern is prose often enough that a hard refusal would
 * cost more than it saves.
 *
 * But the ORIGINAL SIN WAS SILENCE, NOT DELIVERY. What made the swallowed
 * --message-file so expensive was that the sender saw success and the
 * recipient saw noise, so six briefs vanished across three recipients and were
 * only ever rescued by the recipients' own initiative. A warning restores the
 * missing signal at the sender's end without risking a single legitimate
 * message: the send still happens, and the sender is told what their first word
 * was taken to be. Severity differs too — nothing is lost here, because there
 * is no file left behind on disk; the message arrives, merely stranger than
 * intended.
 */
export function suspectedFlagPrefixWarning(prompt: string): string | undefined {
  const first = prompt.split(/\s+/)[0] ?? "";
  if (!/^--[a-z0-9][a-z0-9-]*$/i.test(first)) return undefined;
  return (
    `send-agent: your message BEGINS with "${first}", which looks like a flag ` +
    `and is not one this command knows. It was sent as ordinary message text. ` +
    `If you meant to pass a flag, check the spelling; if you meant to send a ` +
    `file's contents, the flag is ${PROMPT_FILE_FLAG}. The message WAS ` +
    `delivered — this is a warning, not a refusal.\n`
  );
}

export function parseSendAgentInput(
  args: string[],
  now: () => number = Date.now,
): SendAgentInput {
  const recipientName = args[0];
  if (recipientName === undefined || recipientName.length === 0 || recipientName.startsWith("--")) {
    throw new Error("missing required recipient agent name");
  }
  const promptParts: string[] = [];
  let senderName: string | undefined;
  let key: string | undefined;
  let clearBlocked = false;
  let direct = false;
  let at: string | undefined;
  let after: string | undefined;
  let promptFile: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === CLEAR_BLOCKED_FLAG) {
      clearBlocked = true;
    } else if (argument === DIRECT_FLAG) {
      direct = true;
    } else if (argument === AT_FLAG) {
      if (at !== undefined) throw new Error(`duplicate ${AT_FLAG} flag`);
      at = readFlagValue(args, index, AT_FLAG);
      index += 1;
    } else if (argument === AFTER_FLAG) {
      if (after !== undefined) throw new Error(`duplicate ${AFTER_FLAG} flag`);
      after = readFlagValue(args, index, AFTER_FLAG);
      index += 1;
    } else if (argument === SENDER_NAME_FLAG) {
      if (senderName !== undefined) throw new Error(`duplicate ${SENDER_NAME_FLAG} flag`);
      senderName = readFlagValue(args, index, SENDER_NAME_FLAG);
      index += 1;
    } else if (argument === PROMPT_FILE_FLAG) {
      if (promptFile !== undefined)
        throw new Error(`duplicate ${PROMPT_FILE_FLAG} flag`);
      // `-` means stdin and legitimately looks like a flag, so it is read
      // here rather than through `readFlagValue`'s `--` guard.
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`${PROMPT_FILE_FLAG} needs a non-empty path, or - for stdin`);
      }
      promptFile = value;
      index += 1;
    } else if (argument === KEY_FLAG) {
      if (key !== undefined) throw new Error(`duplicate ${KEY_FLAG} flag`);
      key = readFlagValue(args, index, KEY_FLAG);
      index += 1;
    } else if (MISTAKEN_PROMPT_FILE_FLAGS.has(argument)) {
      throw new Error(
        `${argument} is not a flag; the message-from-file flag is ` +
          `${PROMPT_FILE_FLAG}. Refused rather than silently sent, because ` +
          `an unrecognised token becomes part of the MESSAGE — the Regent lost ` +
          `a full brief this way on 2026-08-25, delivering the literal text ` +
          `"${argument} <path>" to its recipient and never learning the ` +
          `message had not arrived.`,
      );
    } else {
      promptParts.push(argument);
    }
  }
  // SHAPE CHECK, added after the named-spelling check proved too narrow. The
  // seven names below catch the guesses we thought of; this catches the
  // MISTAKE, whatever it was spelled. A message whose entire body is one
  // `--token` followed by one path is never a message anybody meant to send —
  // it is a flag that was not recognised, with its argument, silently promoted
  // into the prompt.
  //
  // The Regent hit this six times across three recipients in one evening, and
  // every single one was caught only because the recipient recognised a path
  // and went and read it off disk. One of those was a cold-boot brief written
  // specifically to stop a false claim reaching the Lord. It survived on the
  // initiative of the agent receiving noise, and on nothing else.
  //
  // Deliberately kept as a pure shape test with no filesystem access: the
  // parser stays synchronous and side-effect free, and "two tokens, one
  // flag-shaped, one path-shaped" is already conclusive without asking
  // whether the file exists.
  if (promptParts.length === 2) {
    const [head, tail] = promptParts as [string, string];
    if (head.startsWith("--") && /^[~/]/.test(tail)) {
      throw new Error(
        `the whole message is "${head} ${tail}" — that is an unrecognised flag ` +
          `and its argument, not a message. Every unrecognised token joins the ` +
          `PROMPT, so this would have been DELIVERED verbatim while the file it ` +
          `names stayed on disk, with no error at either end. If you meant to ` +
          `send the contents of ${tail}, the flag is ${PROMPT_FILE_FLAG}.`,
      );
    }
  }
  if (promptFile !== undefined && promptParts.length > 0) {
    // Refused rather than silently preferring one: a caller who passed both
    // has two different ideas of what the message is, and guessing which
    // wins is how the wrong one gets sent.
    throw new Error(
      `pass either a prompt argument or ${PROMPT_FILE_FLAG}, not both`,
    );
  }
  if (promptFile === undefined && promptParts.length === 0)
    throw new Error("missing required prompt");
  const scheduled = parseScheduledSendTiming(at, after, direct, now());
  return {
    recipientName: canonicalIdentityName(recipientName),
    prompt: promptParts.join(" "),
    ...(promptFile === undefined ? {} : { promptFile }),
    senderName,
    key,
    clearBlocked,
    direct,
    ...(scheduled === undefined ? {} : { scheduled }),
  };
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} needs a non-empty value`);
  }
  return value;
}

function parseScheduledSendTiming(
  at: string | undefined,
  after: string | undefined,
  direct: boolean,
  now: number,
): ScheduledSendTiming | undefined {
  if (at !== undefined && after !== undefined) throw new Error(`${AT_FLAG} and ${AFTER_FLAG} are mutually exclusive`);
  if (at === undefined && after === undefined) return undefined;
  if (direct) throw new Error(`${DIRECT_FLAG} cannot be used with scheduled delivery`);
  const dueAtMs = at === undefined ? now + parseDuration(after!) : parseRfc3339Timestamp(at);
  if (!Number.isSafeInteger(dueAtMs) || dueAtMs <= now) throw new Error("scheduled delivery time must be in the future");
  return { dueAt: new Date(dueAtMs).toISOString(), dueAtMs };
}

function parseRfc3339Timestamp(value: string): number {
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${AT_FLAG} requires an RFC3339 timestamp with an explicit timezone`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${AT_FLAG} requires a valid RFC3339 timestamp`);
  return timestamp;
}

function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (match === null) throw new Error(`${AFTER_FLAG} requires a duration such as 500ms, 30s, 5m, 2h, or 1d`);
  const units: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const milliseconds = Number(match[1]) * units[match[2]!];
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error(`${AFTER_FLAG} requires a positive duration`);
  return milliseconds;
}
