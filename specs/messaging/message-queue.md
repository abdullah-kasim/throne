# Message queue
Summary: Stores every message durably in SQLite, delivers it in one lane per recipient, and lets senders track, cancel, read and acknowledge it.
Code: src/message-queue, src/message-status, src/cancel-message, src/read-message, src/delivery-failures, src/throne-work
Search words: message-status, cancel-message, read-message, delivery-failures, queue-health, verify-delivery-path, sqlite

## What it does

Every send becomes a row in a SQLite queue with a delivery state. The backend delivers queued messages in one lane per recipient: one message per recipient at a time, in the order queued (by row id), with at most four recipients delivering at once. A delivery still under way after ten seconds stops counting against the four, so another recipient's message can start, while it keeps its own lane until it ends. When a delivery ends for any reason (delivered, put back, failed, thrown) its lane is freed and the next due message starts at once; a one-second tick notices rows queued by other processes and dispatches every other kind of work. A later message for a recipient waits while an earlier one is still queued, even when the earlier one is backing off; a message scheduled for later holds up nothing until it is due. A message put back because the composer is busy is due again one second later, so it never holds up a message for an idle recipient. A message sent over an agent's delivery socket that the agent answers `accepted` waits in the state `accepted` until the agent calls back: delivered or failed. Once a minute the backend asks `GET /alive` of the agent behind every accepted message; one that does not answer gets the sender a delivery failure notice and the message is queued again under the same id, so it may arrive twice; while the agent answers there is no time limit. Senders poll it with `message-status`, cancel a scheduled row with `cancel-message`, print its stored text with `read-message`, and list or acknowledge failed deliveries with `delivery-failures`. `queue-health` and `verify-delivery-path` prove the queue and the delivery path end to end with one verdict.

## Sub-features

- MQ-LANES: Messages are delivered one per recipient at a time in queue order, up to four recipients at once, a delivery slower than ten seconds giving back its place among the four while keeping its lane, the next starting as soon as a place is free.
- MQ-STATUS: A row id reports its delivery state, `accepted` included while the agent holds the message.
- MQ-CANCEL: A message can be cancelled only before delivery begins.
- MQ-READ: Only the recipient or the sender may read a stored message.
- MQ-FAILURES: Unacknowledged delivery failures are listed until acknowledged, an accepted message lost with its agent among them.
- MQ-HEALTH: Health and delivery-path checks print one verdict.

## How to reach it and prove it works

Run `throne queue-health`; it prints one verdict and exits 0 on a healthy court. The hard-kill guarantee is proven by:

```
bun test ./src/message-queue/sqlite-delivery-sandbox.hard-kill.test.ts
```

The accepted state, the callback and the lost-message check are proven by:

```
bun test ./src/message-queue/message-queue.store.spec.ts ./src/message-status/message-status.spec.ts ./src/delivery-callback/delivery-callback.hosted-worker.spec.ts ./src/throne-backend/lost-accepted-message.hosted-worker.spec.ts
```

The delivery lanes are proven by:

```
bun test ./test/message-lanes.test.ts
```

## Gotchas

A cancelled or delivered row cannot be cancelled again. Reading another agent's message is refused. A message whose recipient cannot be resolved fails at once with "recipient could not be addressed, nothing was typed" and is not retried.
