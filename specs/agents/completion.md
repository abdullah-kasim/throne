# Agent completion and reaping
Summary: Verifies an agent finished and tears it down.
Code: src/complete-agent, src/reap-agent, src/accept-slice, src/slice-assignment
Search words: complete-agent, reap-agent, accept-slice, lint-slice-assignment, reap, reapable

## What it does

`complete-agent` reaps an agent only after verifying its completion signal. `reap-agent` tears one down and requires `--reason`. `accept-slice` lets a supervisor accept a verdict-only Shadow's slice without git. `lint-slice-assignment` exits 1 when an ASSIGNMENT.md lacks its completion section.

## Sub-features

- CO-VERIFY: Completion is verified before reaping.
- CO-REASON: reap-agent refuses without a reason.
- CO-ACCEPT: Only the supervisor accepts a no-merge slice.
- CO-LINT: A missing completion section fails the assignment lint.

## How to reach it and prove it works

Run `throne lint-slice-assignment` on an ASSIGNMENT.md with its completion section removed; it exits 1 and names the missing section. On an intact one it exits 0.

## Gotchas

complete-agent also refuses an Alpha whose outcome is missing from the where-i-stand page.
