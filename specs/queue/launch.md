# Campaign launch
Summary: Prepares a queue row for launch and briefs the new Alpha.
Code: src/situation-brief, src/lint-queue-plan, src/mark-queue-launch-eligible, src/stage-launch-brief
Search words: situation-brief, lint-queue-plan, mark-queue-launch-eligible, stage-launch-brief, launch

## What it does

`lint-queue-plan` checks a plan body for the canonical section markers, and, given a target repository (`--target-repo <path>`, or the row's own launch target with `--objective-code`), runs the same spec citation check `add-to-queue` runs; with no target its output is unchanged; `mark-queue-launch-eligible` adds launch metadata; `stage-launch-brief` stages a brief the Regent authorized; `situation-brief` prints the row's amendments, branch state, neighbouring work and pull requests, and is appended to each new Alpha's opening prompt.

## Sub-features

- LA-LINT: A plan missing a marker fails the lint.
- LA-SPECCITE: With a target whose spec is in throne's form, a body naming none of its sub-feature IDs and no `SPECS: none applies` reason fails the lint; the pass line says it proves only that an ID was copied, not that the spec was read.
- LA-ELIGIBLE: Launch-eligible rows carry complete metadata.
- LA-BRIEF: Every new Alpha receives the situation brief.

## How to reach it and prove it works

Write a plan body without its section markers to a file in ~/tmp and run `throne lint-queue-plan --body-file <file>` on it; it exits non-zero naming the missing markers. Run it again with `--target-repo` pointing at this repository on a body that cites no sub-feature ID; it exits non-zero naming the spec path and the `SPECS: none applies` line.

## Gotchas

A row without metadata is never spawned by the autoscaler.

A spec that cannot be read, or declares no sub-feature IDs, prints one line and skips the citation check rather than failing it.
