# Message queue
Summary: Stores every message durably in SQLite, delivers it in one lane per recipient, and lets senders track, cancel, read and acknowledge it.
Code: src/message-queue, src/message-status, src/cancel-message, src/read-message, src/delivery-failures, src/throne-work
Search words: message-status, cancel-message, read-message, delivery-failures, queue-health, verify-delivery-path, sqlite

## What it does

Every send becomes a row in a SQLite queue with a delivery state. The backend delivers queued messages in one lane per recipient: one message per recipient at a time, in the order queued (by row id), with at most four recipients delivering at once. When a delivery ends for any reason (delivered, put back, failed, thrown) its lane is freed and the next due message starts at once; a one-second tick notices rows queued by other processes and dispatches every other kind of work. A later message for a recipient waits while an earlier one is still queued, even when the earlier one is backing off. A message put back because the composer is busy is due again one second later, so it never holds up a message for an idle recipient. Senders poll it with `message-status`, cancel a scheduled row with `cancel-message`, print its stored text with `read-message`, and list or acknowledge failed deliveries with `delivery-failures`. `queue-health` and `verify-delivery-path` prove the queue and the delivery path end to end with one verdict.

## Sub-features

- MQ-LANES: Messages are delivered one per recipient at a time in queue order, up to four recipients at once, the next starting as soon as one ends.
- MQ-STATUS: A row id reports its delivery state.
- MQ-CANCEL: A message can be cancelled only before delivery begins.
- MQ-READ: Only the recipient or the sender may read a stored message.
- MQ-FAILURES: Unacknowledged delivery failures are listed until acknowledged.
- MQ-HEALTH: Health and delivery-path checks print one verdict.

## How to reach it and prove it works

Run `throne queue-health`; it prints one verdict and exits 0 on a healthy court. The hard-kill guarantee is proven by:

```
bun test ./src/message-queue/sqlite-delivery-sandbox.hard-kill.test.ts
```

The delivery lanes are proven by:

```
bun test ./test/message-lanes.test.ts
```

## Gotchas

A cancelled or delivered row cannot be cancelled again. Reading another agent's message is refused. A message whose recipient cannot be resolved fails at once with "recipient could not be addressed, nothing was typed" and is not retried.
