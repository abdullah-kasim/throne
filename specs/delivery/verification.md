# Delivery verification
Summary: Proves from git state alone that work landed, and guards protected branches.
Code: src/verify-delivery, src/validate-delivery, src/check-main-integrity, src/push-waiver, src/trim-queue
Search words: verify-delivery, validate-delivery, check-main-integrity, push-waiver, trim-queue, delivery

## What it does

`verify-delivery` checks a branch's delivery from git, independent of reports. `validate-delivery` checks a commit is on a checked-out branch without the ledger. `check-main-integrity` detects commits on a protected branch that did not come through delivery, and repairs nothing. `push-waiver` records why push-check findings are not defects for one push. `trim-queue` archives finished queue items, dry run by default.

## Sub-features

- DV-VERIFY: Delivery is judged from git state.
- DV-VALIDATE: A commit's presence is checked without the ledger.
- DV-INTEGRITY: Undelivered commits on main are reported, never repaired.
- DV-WAIVER: A waiver covers one commit on one branch once.
- DV-TRIM: trim-queue changes nothing without its apply flag.

## How to reach it and prove it works

Run `throne validate-delivery` with this repository and the current HEAD commit; it reports the commit present and exits 0. With a made-up commit id it reports it absent.

## Gotchas

check-main-integrity never trusts the commit author.
