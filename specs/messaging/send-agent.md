# Agent messaging
Summary: Delivers one message to a named agent pane, wrapped in its queue id tags, without overwriting a draft the pane already holds, can force a bare Enter into that pane, and takes over a pane lock held longer than a minute.
Code: src/send-agent, src/send-agent-legacy, src/read-payload, src/pane-prompts, src/delivery-receipt, src/herdr/forced-enter.ts, src/shared-policy/recipient-pane-lock.service.ts, src/shared-policy/recipient-pane-lock-record.ts, src/herdr/herdr-client.ts, src/herdr/herdr-socket.ts
Search words: send-agent, send-agent-legacy, read-payload, mcq, message, pane, draft, message tags, delivery receipt, enter-only, forced enter, pane lock, recipient lock, takeover, lock expiry, herdr socket, compatibility check

## What it does

Agents talk to each other by name. `send-agent` resolves the name to exactly one herdr pane, queues the text, and the backend delivers it serialized per recipient, reading the harness screen first so a human draft is never overwritten and an uncertain submission is never resent blindly.

Every queued delivery, delivery notices included, is typed as three parts: a line `<messageN>`, the sender-attributed text, and a line `</messageN>`, where N is the queue row id. Paths that never enqueue (the throne-bot bridge, for one) type the text with no tags.

After a queued delivery the backend schedules a receipt check that reads the recipient's transcript and grades the message `intact`, `truncated` or `absent`. A transcript turn holding both tags of that id and the whole typed text is intact; one holding only one tag, or both without the whole text, is truncated. Paste wrappers such as Claude's `<pasted_content …>` fold are ignored when looking for the tags. A transcript with no tag for the id falls back to the older form, a trailing `[message N]`, so messages typed before the change still grade.

Herdr reads, lists, process-info, text sends and key presses go over herdr's socket with no process launch, for the pinned herdr binary. The `herdr` command is the fallback when the socket is unreachable, its ping fails, or a reply says the server changed; a herdr refusal is surfaced unchanged, never retried on the command line. A write whose socket reply is lost fails as `socket_outcome_unknown` and is never resent. Herdr's compatibility check runs once per process and again only when the herdr binary changes, the session name changes, or a herdr call fails saying the server changed (`server_not_running`, `server_unavailable`, `protocol_mismatch`); a foreign or incompatible server is refused on every call.

Long texts are staged as payloads that `read-payload` reads once and deletes. `mcq` answers or dismisses an interactive prompt holding up a pane, for the Regent or a Stager. `send-agent-legacy` is the synchronous fallback that predates the queue.

`send-agent <name> --enter-only` is the forced Enter. It runs in the caller's own process, with or without `--direct`, and queues nothing. It reads the input box once, capped at 5 seconds. A box covered by a dialog is refused; a box that cannot be read is refused when the harness has a supported screen reader; otherwise one Enter key is sent through herdr's send-keys, taking, checking and waiting on no lock, typing nothing and not reading the box again. A press prints one line and exits 0; a refusal prints the reason and exits 1. The no-idling sweep calls the same function (WD-STUCK-DRAFT).

A delivery writes and presses Enter while holding the recipient pane's lock, and that lock lasts a minute at most (`PANE_LOCK_MAXIMUM_HOLD_MS = 60_000`). The lock is a row in `locks.sqlite3` (see the lock rows spec) holding the holder's process id, start time and the time it was taken; a holder whose process has died frees it at once. A sender that finds the lock held reads that age: under a minute it waits until the lock is released or turns a minute old; at a minute it takes the lock over. The takeover presses the forced Enter on whatever sits in the box (refused only by a dialog or an unreadable box, after which the delivery follows its ordinary rules), replaces the row with the sender's own, logs one line naming the pane, the old process id and the lock's age, and delivers. While another sender holds the lock, a delivery skips its wait for a resident draft to clear before the lock, so the takeover is reached; the draft is handled under the lock. The displaced holder checks it still owns the row before every write and every Enter, stops at once when it does not, and its delivery fails as taken over after a minute and is never retried.

## Sub-features

- MSG-NAME: A target name must resolve to exactly one agent or the send is refused.
- MSG-DRAFT: A draft already waiting in the input box is kept, not overwritten; the exceptions are `--enter-only` and the no-idling sweep, which press Enter on it (MSG-ENTER-ONLY, WD-STUCK-DRAFT).
- MSG-ENTER-ONLY: `--enter-only` presses one Enter at once, ignoring the recipient lock and any queued delivery, and refuses when a dialog covers the box or a supported harness's box cannot be read.
- MSG-LOCK-EXPIRY: A sender waits for a held pane lock until it is a minute old or released, then takes it over with the forced Enter and delivers; the displaced holder writes nothing more and its delivery fails without a retry.
- MSG-TAGS: A queued delivery is typed between `<messageN>` and `</messageN>` lines carrying its queue id.
- MSG-RECEIPT: The receipt check grades a delivery intact, truncated or absent from its tags, falling back to a trailing `[message N]`.
- MSG-HERDR-SOCKET: Herdr calls go over its socket, falling back to the command only when the socket is unreachable or the server changed; a lost write reply is never resent.
- MSG-HERDR-COMPAT: The herdr compatibility check is remembered until the binary, session or server changes; refusals stay.
- MSG-PAYLOAD: A staged payload is read once and then deleted.
- MSG-MCQ: A held prompt can be answered or dismissed by the Regent or a Stager.
- MSG-LEGACY: The legacy path delivers without the queue.

## How to reach it and prove it works

From a herdr session: `throne send-agent <name> "<text>"` prints a message id; `throne message-status <id>` reaches a delivered state and the text appears in the target pane between `<messageN>` and `</messageN>`. `throne send-agent <name> --enter-only` prints `send-agent: pressed Enter in "<name>"'s input box` and the text left in that box is submitted, even while another process holds the pane's lock. A send started when another process has held the pane's lock for over a minute, with text in the box, submits that text first and then delivers the new message whole within 15 seconds; started at 20 seconds, it waits until the lock is released or a minute old. Proven by:

```
bun test ./src/send-agent/payload-transport.test.ts ./src/delivery-receipt/message-tags-verdict.spec.ts ./src/delivery-receipt/recorded-message-tags-verdict.spec.ts ./src/send-agent/send-agent-enter-only.spec.ts ./src/herdr/forced-enter.spec.ts ./src/shared-policy/recipient-pane-lock.service.spec.ts ./src/herdr/pane-lock-takeover.spec.ts ./src/herdr/herdr-socket.test.ts ./src/herdr/herdr-client.test.ts
```

It exits 0. The recorded tests grade real Claude transcript turns kept under `src/delivery-receipt/fixtures/`.

## Gotchas

A name that matches two panes is refused rather than guessed. Delivery needs the backend running; without it messages wait in the queue; `--enter-only` does not need it. Claude folds a long paste into a chip and wraps it in `<pasted_content …>` with leading blank lines, so the delivered turn does not start with `<messageN>`. The three-line form is proven on a real Claude pane only; Codex was not signed in on this host when it was recorded. A message that quotes a paste tag literally can still grade truncated, because the transcript escapes those tags. A Claude menu such as `/model` reads as an unreadable box, so `--enter-only` refuses it with "could not be read" rather than "a dialog covers". `--enter-only` presses even when the box is empty. Only deliveries bind the takeover to the forced Enter; other code that takes the pane lock (model switching, spawn recovery, harness command typing, `mcq`, a bare pane write) takes an expired lock over without pressing Enter. A displaced holder's later release deletes nothing, because a release only removes the row it still owns.
