// THRONE-OWNED omp extension: draft-safe message delivery.
//
// Installed (as a symlink) into ~/.omp/agent/extensions/ by throne startup
// whenever an omp binary is present. It lives BESIDE herdr's own
// `herdr-omp-agent-state.ts` rather than editing it — that file is
// herdr-managed and says so in its header, and reinstalling herdr overwrites
// it.
//
// WHY THIS EXISTS. Neither existing route delivers correctly to omp, measured
// on 2026-08-26 against a live session:
//
//   throne send-agent      writes the text into the composer and never
//                          submits it. The message sits visible and unread;
//                          message-status still reports "delivered".
//   herdr agent prompt     types into whatever is already in the composer and
//                          submits the concatenation. A resident draft
//                          "test" plus an incoming message produced the single
//                          turn "testreply ONLY with the word banana" — the
//                          human's text and the sender's message welded
//                          together with no separator, and the draft gone.
//
// The cause is structural: omp panes are marked `screen_detection_skipped`, so
// the throne's normal composer observation — the thing that powers "never
// overwrite a resident draft" and "never blindly resend" — has nothing to look
// at, and the Claude-branch submit contract does not apply.
//
// The extension API gives something strictly better than screen scraping:
// `ctx.ui.getEditorText()` returns the ACTUAL composer buffer, and
// `sendUserMessage()` enqueues a real user turn without touching the composer
// at all. Delivery becomes an API call gated on a true reading, rather than
// keystrokes gated on a guess about pixels.
//
// PROTOCOL. The throne writes a request JSON file into the request directory
// and polls for an ack of the same id:
//
//   request  <dir>/req-<pane>-<id>.json  { "id", "text", "paneId" }
//   ack      <dir>/ack-<id>.json         { "id", "status", "paneId", "at", "detail"? }
//
//   status: "delivered"  sendUserMessage was called and did not throw
//           "refused"    a terminal refusal; detail says why
//
// REQUESTS ARE ADDRESSED, NOT BROADCAST. Until 2026-08-26 a request carried
// only { id, text } and every instance claimed any req-*.json it saw. With one
// omp instance that is indistinguishable from correct, which is why it passed
// its first test. Measured with THREE live instances (panes w2:p7JQ, w2:p7JS,
// w2:p7JT), delivery was a race: the first instance with an empty composer won
// the message whoever it was for, acked it, and the throne recorded
// "delivered". Because a resident draft makes an instance hold, the winner was
// systematically whichever agent was idle — so busy agents lost their own mail
// to idle ones, and a brief for one Alpha was answered by another.
//
// The recipient's herdr pane id is now in the filename AND the body. The
// filename lets an instance ignore other agents' requests without reading,
// parsing or unlinking them. The body is re-checked because two distinct pane
// ids could in principle sanitize to the same filename token.
//
// FAIL CLOSED. An instance that cannot learn its own pane id delivers NOTHING.
// The alternative — falling back to "take everything" — is precisely the
// defect above, and a silent non-delivery is recoverable while a message
// answered by the wrong agent is not.
//
// A request with a draft resident is NOT acked until the composer clears. The
// throne's own send timeout decides how long to wait, exactly as it does for
// every other harness — this side simply never lies about what happened.
//
// NEVER CANCEL AN IN-FLIGHT TURN. `sendUserMessage(text)` with no options is
// not a neutral default: omitted `deliverAs` means "start a turn when idle,
// queue as a STEER while streaming" (pi-coding-agent
// `src/session/agent-session.ts`, `sendUserMessage` falls through to
// `prompt(text, { streamingBehavior: "steer" })`). A steer preempts the turn
// it lands in, and omp drops the recipient's pending tool calls to service it:
// `Skipped due to queued user message. … retry the skipped tool if it is still
// needed.`
//
// Measured 2026-08-27 in the live Regent's scrollback: 19 skipped tool calls
// against 17 incoming messages in 1000 lines, the SAME `Eval` cancelled three
// times running (once per arriving message) before it could execute. NONE of
// those messages came from the Lord — six were one autoreap sweep re-paging an
// unchanged condition, the rest Alpha status reports and the keep-going
// heartbeat. The court was preempting its own Regent with routine traffic,
// because a sender has no way to say "this can wait".
//
// So delivery is state-dependent, and the state is read from omp itself rather
// than tracked here:
//
//   streaming  deliverAs: "followUp" — queued, drained at the turn boundary by
//              omp's own `#scheduleQueuedMessageDrain`. No tool call dies.
//   idle       options OMITTED — starts a real turn immediately. `followUp`
//              must NOT be used here: it never starts a turn, so a message to
//              an idle agent would sit unread until something else woke it.
//
// UNKNOWN STATE FAILS TOWARD DELIVERY, not toward silence: an unreadable
// `isIdle()` takes the omitted-options path, whose worst case is the preempt
// this change exists to remove — bad, and strictly better than a message that
// never arrives.
//
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR =
  process.env.THRONE_OMP_DELIVERY_DIR ??
  path.join(os.homedir(), ".throne", "data", ".runtime", "omp-delivery");
const POLL_MS = 500;

/** herdr sets this in every pane it owns; it is the only thing an omp instance
 *  knows about which agent it is. Absent => this instance delivers nothing. */
const PANE_ID = (process.env.HERDR_PANE_ID ?? "").trim();

/** Mirrors sanitizePaneId in src/herdr/omp-delivery-client.ts. Both sides must
 *  agree character-for-character or every request is silently ignored. */
function sanitizePaneId(paneId) {
  return paneId.replace(/[^A-Za-z0-9_-]/g, "_");
}

const REQUEST_PREFIX = PANE_ID === "" ? null : `req-${sanitizePaneId(PANE_ID)}-`;

function log(pi, line) {
  try {
    pi.logger?.debug?.(`throne-omp-delivery: ${line}`);
  } catch {}
}

export default function (pi) {
  // `ctx.ui` — not `pi.ui` — owns getEditorText (ExtensionUIContext). ctx is
  // only handed to HANDLERS, so it is captured from lifecycle events and the
  // latest one kept. Without a ctx the composer is UNREADABLE, which is
  // treated as "not safe to deliver", never as "empty".
  let ctxRef = null;
  const capture = (_event, ctx) => {
    if (ctx?.ui) ctxRef = ctx;
  };
  for (const event of [
    "session_start",
    "session_switch",
    "agent_start",
    "turn_start",
    "turn_end",
    "user_message",
  ]) {
    try {
      pi.on(event, capture);
    } catch {}
  }

  /** The composer's real contents, or null when it cannot be read. */
  function readDraft() {
    const fn = ctxRef?.ui?.getEditorText;
    if (typeof fn !== "function") return null;
    try {
      const value = fn.call(ctxRef.ui);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  /** Whether omp says the agent is idle, or null when it cannot be asked.
   *  `ctx.isIdle()` is omp's own live answer ("whether the agent is idle (not
   *  streaming)"), so no turn_start/turn_end bookkeeping is kept here — a
   *  missed event would silently pin this side to the wrong state for the rest
   *  of the session. */
  function readIdle() {
    const fn = ctxRef?.isIdle;
    if (typeof fn !== "function") return null;
    try {
      const value = fn.call(ctxRef);
      return typeof value === "boolean" ? value : null;
    } catch {
      return null;
    }
  }

  function ack(id, status, detail) {
    const body = { id, status, paneId: PANE_ID, at: new Date().toISOString() };
    if (detail !== undefined) body.detail = detail;
    const target = path.join(DIR, `ack-${id}.json`);
    // Write-then-rename so the throne never reads a half-written ack.
    const staging = `${target}.partial`;
    try {
      fs.writeFileSync(staging, `${JSON.stringify(body)}\n`);
      fs.renameSync(staging, target);
    } catch {}
  }

  if (REQUEST_PREFIX === null) {
    log(
      pi,
      "HERDR_PANE_ID is unset — this instance cannot tell which messages are " +
        "addressed to it and will deliver NOTHING. Relaunch this pane through " +
        "the throne so herdr sets the variable.",
    );
    return;
  }

  const timer = setInterval(() => {
    let entries;
    try {
      entries = fs.readdirSync(DIR);
    } catch {
      return; // directory absent until the throne creates it
    }
    for (const entry of entries) {
      // Another agent's request is not ours to read, parse, ack or delete.
      if (!entry.startsWith(REQUEST_PREFIX) || !entry.endsWith(".json")) continue;
      const requestPath = path.join(DIR, entry);
      let request;
      try {
        request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      } catch {
        continue; // mid-write; try again next tick
      }
      // Belt to the filename's suspenders: a sanitized-token collision would
      // put someone else's request behind our prefix, and delivering it would
      // be the original defect wearing a fix.
      if (typeof request?.paneId === "string" && request.paneId !== PANE_ID) {
        log(pi, `ignoring ${entry}: addressed to pane ${request.paneId}`);
        continue;
      }
      if (typeof request?.id !== "string" || typeof request?.text !== "string") {
        try {
          fs.unlinkSync(requestPath);
        } catch {}
        ack(String(request?.id ?? entry), "refused", "malformed request");
        continue;
      }

      const draft = readDraft();
      if (draft === null) {
        log(pi, `holding ${request.id}: composer unreadable`);
        continue; // NEVER deliver on an unknown composer
      }
      if (draft.trim() !== "") {
        log(pi, `holding ${request.id}: resident draft`);
        continue; // a resident draft outranks every sender
      }

      // Consume the request BEFORE sending, so a throw cannot resend it.
      try {
        fs.unlinkSync(requestPath);
      } catch {
        continue;
      }
      // Streaming => queue behind the live turn. Idle (or unknown) => omitted
      // options, the only path that starts a turn. See NEVER CANCEL AN
      // IN-FLIGHT TURN in the header.
      const idle = readIdle();
      try {
        if (idle === false) {
          pi.sendUserMessage(request.text, { deliverAs: "followUp" });
        } else {
          pi.sendUserMessage(request.text);
        }
        ack(request.id, "delivered");
        log(
          pi,
          `delivered ${request.id} as ${idle === false ? "followUp" : "turn"}`,
        );
      } catch (error) {
        ack(request.id, "refused", `sendUserMessage threw: ${String(error)}`);
      }
    }
  }, POLL_MS);
  timer.unref?.();
}
