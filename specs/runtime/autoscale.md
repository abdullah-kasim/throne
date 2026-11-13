# Alpha autoscale
Summary: Spawns Alphas for launch-eligible queue rows on a schedule or on demand.
Code: src/alpha-autoscale, src/alpha-launch-queue
Search words: alpha-autoscale-tick, autoscale-now, autoscale-status, verify-alpha-floor-delivery, autoscale, spawn

## What it does

Every five minutes the backend runs one autoscale sweep under a cross-process lock: it reads the queue and spawns an Alpha for each launch-eligible row within capacity. `autoscale-now` runs it immediately; `autoscale-status` shows what the next run would do and lists deferred rows as held. `verify-alpha-floor-delivery` proves the breached-floor notifier delivers.

## Sub-features

- AS-SWEEP: One sweep at a time, under the sweep lock.
- AS-NOW: autoscale-now is an alias of alpha-autoscale-tick.
- AS-STATUS: Status changes nothing and shows held deferred rows.
- AS-ABANDONED: An abandoned row stays closed.

## How to reach it and prove it works

`throne autoscale-status` prints the state and exits 0. Then:

```
bun test ./src/alpha-autoscale/abandoned-row-stays-closed.test.ts
```

## Gotchas

The autoscaler can be paused in `config.user.ts`; status says so.
