# Alpha autoscale
Summary: Spawns Alphas for launch-eligible queue rows and keeps a Stager alive, on a schedule or on demand.
Code: src/alpha-autoscale, src/alpha-launch-queue
Search words: alpha-autoscale-tick, autoscale-now, autoscale-status, verify-alpha-floor-delivery, autoscale, spawn, stager floor

## What it does

Every five minutes the backend runs one autoscale sweep under a cross-process lock: it reads the queue and spawns an Alpha for each launch-eligible row within capacity. When no Stager is live, the sweep spawns one with `create-agent --role Stager` and no `--model`, so it takes the first pair of the active Stager pool (Opus unless `stagerPool` in `config.user.ts` says otherwise). `autoscale-now` runs it immediately; `autoscale-status` shows what the next run would do and lists deferred rows as held. `verify-alpha-floor-delivery` proves the breached-floor notifier delivers.

## Sub-features

- AS-SWEEP: One sweep at a time, under the sweep lock.
- AS-NOW: autoscale-now is an alias of alpha-autoscale-tick.
- AS-STATUS: Status changes nothing and shows held deferred rows.
- AS-ABANDONED: An abandoned row stays closed.
- AS-STAGER-FLOOR: A missing Stager is respawned on the Stager pool's first pair, never a named model.

## How to reach it and prove it works

`throne autoscale-status` prints the state and exits 0. Then:

```
bun test ./src/alpha-autoscale/abandoned-row-stays-closed.test.ts
bun test ./test/stager-floor-spawns-its-stager-on-the-stager-pools-first-pair.test.ts
```

## Gotchas

The autoscaler can be paused in `config.user.ts`; status says so.
