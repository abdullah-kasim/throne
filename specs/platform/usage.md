# Usage and capacity
Summary: Reports plan usage, token lanes, host pressure and the Claude and provider accounts agents run on.
Code: src/plan-usage-remaining, src/codex-usage-remaining, src/opencode-go-usage-remaining, src/usage-rate, src/token-balance, src/resource-pressure, src/account
Search words: plan-usage-remaining, codex-usage-remaining, opencode-go-usage-remaining, usage-rate, token-balance, resource-pressure, account, usage

## What it does

The usage commands report what is left on the Claude, Codex and OpenCode Go plans and the burn rate. `token-balance` picks the lane for balanced spawns; `resource-pressure` reports host load, IO and memory with the admission verdict. `account` lists, adds and switches the Claude account folders. `account add <name> --provider deepseek --key-file <file>` adds a provider account to `providerAccounts` in accounts.json, copying the key to `<throne home>/accounts/pi/<name>/api-key` (folder 700, file 600); `account list` shows provider rows as pay per token with the agents on them, never the key. A file holding only provider accounts reads as no Claude accounts.

## Sub-features

- US-PLAN: Plan usage is read from a cache and never refreshes the shared login.
- US-LANE: token-balance names a lane or why neither is usable.
- US-PRESSURE: Pressure carries the admission verdict.
- US-ACCOUNT: account list shows each account's login, usage and live agents.
- US-PROVIDER: A DeepSeek provider account stores its key at mode 600 and is ready for a pi launch only when that file exists, is non-empty and is mode 600.

## How to reach it and prove it works

Run `throne resource-pressure`; it prints a verdict with load, IO and memory and exits 0. Then:

```
bun test ./src/plan-usage-remaining/plan-usage-never-refreshes-the-shared-login.test.ts
```

## Gotchas

Usage numbers come from the Lord's accounts, so they cannot be checked offline. Provider accounts are proven offline by `bun test ./test/account-provider-a-deepseek-account-is-added-listed-and-ready-for-launch.test.ts`.
