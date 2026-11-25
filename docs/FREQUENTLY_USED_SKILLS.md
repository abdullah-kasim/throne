# Frequently used skills

The skills to learn first. Every skill, with its full description, is in
[THRONE_SKILLS.md](THRONE_SKILLS.md).

## Typed by name

- [`/update-harnesses`](THRONE_SKILLS.md) — checks, updates, pins, promotes or rolls back the throne-managed Claude Code and Codex installations.
- [`/update-herdr`](THRONE_SKILLS.md) — checks, rehearses and applies a herdr release, restarting herdr only on your word.
- [`/gauntlet`](THRONE_SKILLS.md) — turns one request to make a product match its reference into a builder campaign and a checker campaign that keeps fixing it until it passes.
- [`/pr-merge`](THRONE_SKILLS.md) — lands a stack of pull requests by rolling them into the root and squash-merging it as one commit.
- [`/where-i-stand`](THRONE_SKILLS.md) — shows the page of what you are working on, then reports only what differs in the forges, the queue and the live agents.
- [`/update-throne`](THRONE_SKILLS.md) — brings this install up to date in one step: pulls, builds, moves the harnesses and herdr to their pinned versions, and reports.
- [`/install-throne`](THRONE_SKILLS.md) — installs throne, or repairs a broken install, until the herdr service runs and the Regent and a Stager are live.
- [`/restart-harnesses`](THRONE_SKILLS.md) — restarts every live agent's harness in place so the court runs the newly pinned binary.
- [`/frontend-critic`](THRONE_SKILLS.md) — renders a web UI change in real browsers, measures and operates it, and reports each defect with its fix.
- [`/pr-promote`](THRONE_SKILLS.md) — copies a finished Forgejo pull request to GitHub, and on a second run carries review answers back.

## Usually run for you

These are usually executed automatically: you say what you want in plain
words ("queue this", "no alpha", "amend that") and the agent you are
talking to runs the skill. You rarely type the name.

- [`/queue-objective`](THRONE_SKILLS.md) — say "queue this"; turns your objective into a launch-ready queue row, files it and tells the Regent.
- [`/agent-browser`](THRONE_SKILLS.md) — say "open a website" or "take a screenshot"; the browser automation command line for agents.
- [`/no-alpha`](THRONE_SKILLS.md) — say "no alpha"; the agent you are talking to does the task in its own session instead of spawning an Alpha.
- [`/throne-fork`](THRONE_SKILLS.md) — a Stager forks a new Stager when your prompt changes its topic.
- [`/amendment`](THRONE_SKILLS.md) — say "amend that"; records your change to a filed queue row and tells its Alpha and the Regent.
