# Message queue
Summary: Stores every message durably in SQLite and lets senders track, cancel, read and acknowledge it.
Code: src/message-queue, src/message-status, src/cancel-message, src/read-message, src/delivery-failures, src/throne-work
Search words: message-status, cancel-message, read-message, delivery-failures, queue-health, verify-delivery-path, sqlite

## What it does

Every send becomes a row in a SQLite queue with a delivery state. Senders poll it with `message-status`, cancel a scheduled row with `cancel-message`, print its stored text with `read-message`, and list or acknowledge failed deliveries with `delivery-failures`. `queue-health` and `verify-delivery-path` prove the queue and the delivery path end to end with one verdict.

## Sub-features

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

## Gotchas

A cancelled or delivered row cannot be cancelled again. Reading another agent's message is refused. A message whose recipient cannot be resolved fails at once with "recipient could not be addressed, nothing was typed" and is not retried.
