# Agent observation
Summary: Shows which agents are alive, what they print, and how long they take.
Code: src/assert-herdr, src/agent-logs, src/agent-statuses, src/agent-stats, src/process-inspection
Search words: assert-herdr, agent-logs, agent-statuses, agent-stats, herdr, status, busy check, process table

## What it does

`agent-statuses` prints a table of every herdr agent and its status; `agent-logs` prints one agent's recent output; `agent-stats` reports timing statistics over seven days. `assert-herdr` refuses to run outside a herdr session, so scripts can guard on it. The busy check behind a status (is the harness running tool work, or only its launch clean-up loop) reads the process table once per pass and shares it with every pane in that pass: the roster, blocked-agent paging and no-idling each count as a pass. On Linux the table is read in-process from `/proc`, launching no child, with command lines rendered the way `ps` prints them (newlines and NULs as spaces); on macOS `ps` runs once per pass and `lsof` at most once. Every `/proc` scan, for any caller, reads at most 32 processes at a time.

## Sub-features

- OBS-TABLE: Every herdr agent appears once with its status.
- OBS-LOGS: A named agent's recent output is printed.
- OBS-STATS: Timing statistics cover the trailing seven days.
- OBS-BUSY-PASS: A busy-check pass reads the process table once for all panes; on Linux without launching a child.
- OBS-ASSERT: Outside herdr, assert-herdr exits non-zero.

## How to reach it and prove it works

Inside herdr run `throne agent-statuses`; your own name is listed. The roster logic alone:

```
bun test ./src/agent-statuses/agent-statuses-roster.spec.ts ./src/process-inspection/process-table.spec.ts
```

## Gotchas

Status comes from herdr and pane evidence, so a pane mid-redraw can read as busy for a moment.
