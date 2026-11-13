# Campaign launch
Summary: Prepares a queue row for launch and briefs the new Alpha.
Code: src/situation-brief, src/lint-queue-plan, src/mark-queue-launch-eligible, src/stage-launch-brief
Search words: situation-brief, lint-queue-plan, mark-queue-launch-eligible, stage-launch-brief, launch

## What it does

`lint-queue-plan` checks a plan body for the canonical section markers; `mark-queue-launch-eligible` adds launch metadata; `stage-launch-brief` stages a brief the Regent authorized; `situation-brief` prints the row's amendments, branch state, neighbouring work and pull requests, and is appended to each new Alpha's opening prompt.

## Sub-features

- LA-LINT: A plan missing a marker fails the lint.
- LA-ELIGIBLE: Launch-eligible rows carry complete metadata.
- LA-BRIEF: Every new Alpha receives the situation brief.

## How to reach it and prove it works

Write a plan body without its section markers to a file in ~/tmp and run `throne lint-queue-plan --body-file <file>` on it; it exits non-zero naming the missing markers.

## Gotchas

A row without metadata is never spawned by the autoscaler.
