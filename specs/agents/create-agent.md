# Agent creation
Summary: Spawns a new harness in herdr with a validated identity, model and spawn evidence.
Code: src/create-agent, src/create-agent-legacy, src/harness-routing, src/derive-shadow-name-from-alpha, src/list-harnesses-and-models, src/check-config, src/config.ts
Search words: create-agent, create-agent-legacy, derive-shadow-name-from-alpha, list-harnesses-and-models, check-config, model, harness, role pool

## What it does

Policy and effects are separate. `src/config.ts` declares model pools and steering; harness routing decides usage, capability, admission and steering for a fresh spawn; `create-agent` validates the result, persists identity and spawn evidence in the ledger, and launches the harness in a herdr pane. `derive-shadow-name-from-alpha` gives the canonical Shadow name for an Alpha and slice. `list-harnesses-and-models` and `check-config` show the pools and each role's model and effort.

## Sub-features

- CA-POLICY: Capability floors and role-pool admission are hard gates outside steering.
- CA-LEDGER: Identity and spawn evidence are persisted before launch.
- CA-SHADOW-NAME: A Shadow name is derived from its Alpha name and slice id.
- CA-CONFIG: check-config validates config.user.ts and prints each role's model.

## How to reach it and prove it works

Take the name of a live Alpha from `throne agent-statuses`, for example `alpha-<code>-01`, then:

```
throne derive-shadow-name-from-alpha alpha-<code>-01 06
```

Prints `shadow-<code>-06` and exits 0. With an Alpha name that has no spawn evidence it exits 1 and says so; with no arguments it exits 1 and names what is required.

## Gotchas

The derive command takes positional arguments only; flags are refused. It reads the Alpha's spawn evidence from the ledger, so it works only for a registered Alpha.
