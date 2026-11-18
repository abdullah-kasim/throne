# Agent completion and reaping
Summary: Verifies an agent finished and tears it down.
Code: src/complete-agent, src/reap-agent, src/accept-slice, src/slice-assignment
Search words: complete-agent, reap-agent, accept-slice, lint-slice-assignment, reap, reapable

## What it does

`complete-agent` reaps an agent only after verifying its completion signal. `reap-agent` tears one down and requires `--reason`. A live agent is admitted for reaping only when its state file (see the agent state spec) says `reapable` with a reason other than `fail`, which the agent declares with `throne my-state reapable completed` or a `{"reapable":"completed"}` marker that Claude's turn-end hook records; anything else, a missing file included, is refused. The pane is never read. A verdict-only Shadow is proven complete by its verdict shape plus the state `reapable` with reason `completed`. `accept-slice` lets a supervisor accept a verdict-only Shadow's slice without git. `lint-slice-assignment` exits 1 when an ASSIGNMENT.md lacks its completion section.

## Sub-features

- CO-VERIFY: Completion is verified before reaping.
- CO-CLAIM: A live agent is reaped only when its state file says `reapable` with a reason other than `fail`.
- CO-REASON: reap-agent refuses without a reason.
- CO-ACCEPT: Only the supervisor accepts a no-merge slice.
- CO-LINT: A missing completion section fails the assignment lint.
- CO-PROFILE: Reaping an agent removes its own `~/.agent-browser/profiles/web-search-<name>` copy and never the base `web-search` profile (`test/reap-removes-web-search-profile-copy.test.ts`).

## How to reach it and prove it works

Run `throne lint-slice-assignment` on an ASSIGNMENT.md with its completion section removed; it exits 1 and names the missing section. On an intact one it exits 0.

```
bun test ./src/reap-agent/reapability-claim.spec.ts ./test/reap-agent-completes-after-live-claim.test.ts
```

It exits 0.

## Gotchas

complete-agent also refuses an Alpha whose outcome is missing from the where-i-stand page. A claim lasts only until the agent's next prompt, when the turn-start hook resets the file to `working`; an agent that receives a message after claiming must claim again.
