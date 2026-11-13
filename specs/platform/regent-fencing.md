# Regent fencing and suite arbitration
Summary: Hands context to a freshly summoned Regent and records who holds the full suite.
Code: src/regent-fencing
Search words: consume-fence-handoff-on-start, record-suite-hold, record-suite-release, read-suite-arbitration, fence

## What it does

When a Regent is fenced, a handoff record says why; `consume-fence-handoff-on-start` reads and clears it for the successor. `record-suite-hold` and `record-suite-release` note which campaign holds full-suite access; `read-suite-arbitration` prints the holders.

## Sub-features

- RF-HANDOFF: The handoff is read once and cleared.
- RF-SUITE: Suite holders are recorded and listed.

## How to reach it and prove it works

Run `throne read-suite-arbitration`; it prints the current holders (possibly none) and exits 0.

## Gotchas

Reading the handoff clears it.
