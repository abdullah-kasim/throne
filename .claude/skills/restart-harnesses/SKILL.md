---
name: restart-harnesses
description: 'This throne-local skill restarts every live agent''s harness process in place after /update-harnesses moved the pin, so the court actually runs the newly vendored Claude Code or Codex binary. Each agent is stopped, relaunched into its exact native session in its own pane, and its herdr name is re-asserted. Invoked by /restart-harnesses [--dry-run] [--force] [--only <name>], or when the Lord says "restart the harnesses", "restart all agents onto the new binary", "reload the court", or "the agents are still on the old version".'
version: 1.0.0
user-invocable: true
---

# Restart the court's harness processes

A harness pin change (`/update-harnesses`) rewrites `vendor/`, but every
running agent keeps executing the binary it already loaded until its process
restarts. This skill is that restart, done without losing anyone's
conversation: `throne restart-harnesses` stops each live agent's harness,
relaunches it in the same pane with the exact native session resumed, and
makes sure the pane still carries the agent's name afterwards.

## What it does, per agent

1. Reads the live roster (`herdr agent list`) and the invoking pane.
2. Records the agent's live native session id into its ledger `spawn.json`
   when it is missing or different, so the resume has a durable recipe and
   the startup reconciliation gains the same exact-resume ability later.
3. Sends `SIGTERM` to the harness process in the pane, waits up to 30 s for
   the pane to return to its shell, escalates to `SIGKILL` once, and fails
   loudly if the process survives both.
4. Resumes the agent through the same path startup reconciliation uses
   (`resumeOrphan`): the pane is relaunched with `--resume <session>` (or
   `resume <session>` for Codex) under the registered name, and an opening
   prompt tells the agent its harness was restarted and its transcript is
   its own.
5. Verifies a pane in the agent's tab carries the registered name; a relaunch
   that came back as a bare `claude`/`codex` is renamed. This is the trap the
   Lord named on 2026-09-14: a resumed harness surfaces in herdr as a new,
   unnamed agent unless something claims the name again.

The Regent is restarted last and under the resurrect lock, so the keep-going
watchdog cannot race the restart with a second Regent. A held lock skips the
Regent with a warning.

## What it refuses or skips

- **Agents whose status is `working`**, unless `--force`. Killing a harness
  mid-tool-call is safe for the transcript but loses the in-flight tool
  result; let it finish or force it knowingly.
- **Unnamed panes.** Nothing to resume under, nothing to rename to.
- **Agents whose live native session id herdr cannot see.** Reported as
  failed; not stopped or restarted, since there is no session to resume.

An agent may restart itself, including the one that invoked the command: the
restart is a script running inside the invoker's own harness, so the invoker
is always ordered last, after the Regent — anything scheduled to run after
its own self-stop would otherwise never execute. A live agent that has no
`spawn.json` ledger record no longer fails outright on that account alone:
one is synthesized from herdr's live roster and the agent's own transcript,
so the restart proceeds using that recipe — but the agent still fails if
herdr cannot report its live session id, regardless of whether a spawn
record exists or was synthesized.

## Usage

```bash
throne restart-harnesses --dry-run          # print the plan, touch nothing
throne restart-harnesses                    # restart every eligible live agent
throne restart-harnesses --force            # include agents that are working
throne restart-harnesses --only stager-second --only regent
```

Exit code 0 when nothing failed, 1 when any restart failed, 2 on a bad
argument. Every agent gets one line: `restarted`, `skipped`, or `failed`, with
the reason. The invoking agent's own line always comes last, after the
Regent's.

## After running it

`throne agent-statuses` must list every restarted agent LIVE under its own
name, including the invoker and the Regent. Then, on one restarted agent,
confirm the binary actually moved: the pane's process should show the new
version (`herdr pane process-info --pane <id>` names the running `claude` by
its version) and it should match `vendor-pins.json`.
