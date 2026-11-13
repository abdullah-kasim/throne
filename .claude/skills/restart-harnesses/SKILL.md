---
name: restart-harnesses
description: 'This throne-local skill restarts every live agent''s harness process in place after /update-harnesses moved the pin, so the court actually runs the newly vendored Claude Code or Codex binary. Each agent is stopped, relaunched into its exact native session in its own pane, and its herdr name is re-asserted. Invoked by /restart-harnesses [--dry-run] [--force] [--only <name>], or when the Lord says "restart the harnesses", "restart all agents onto the new binary", "reload the court", or "the agents are still on the old version".'
version: 1.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension restart-harnesses` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

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
   its own. Two cases have no native session to resume: an agent whose spawn
   record holds `harness_executable` relaunches with its recorded arguments
   only, and an agent whose recorded cwd is gone starts in the throne root.
   Both get the ledger rebrief prompt and a `throne-startup:` line saying so.
   Believe that line: the agent's `restarted` line still says `resumed native
   session`.
5. Verifies a pane carries the registered name; a relaunch that came back as a
   bare `claude`/`codex` is renamed. An agent whose tab is gone comes back in a
   new tab, and that is a `restarted` line. This is the trap the
   Lord named on 2026-09-14: a resumed harness surfaces in herdr as a new,
   unnamed agent unless something claims the name again.
6. Reads what the relaunched pane is running. Anything but the vendored binary
   makes the agent's outcome `failed`, naming the executable path, because a
   matching version on another install proves nothing. An agent whose spawn
   record holds `harness_executable` runs that executable by design, so it is
   exempt. A pane with no harness process is `failed` for every agent. A
   `restarted` line names the binary that is running.

The Regent is restarted after every other agent and under the resurrect lock,
so the keep-going watchdog cannot race the restart with a second Regent. Only
the invoker goes later. A held lock gives the Regent a `skipped` line and the
run carries on.

## What it refuses or skips

- **Agents whose status is `working`**, unless `--force`. Killing a harness
  mid-tool-call is safe for the transcript but loses the in-flight tool
  result; let it finish or force it knowingly. The invoking pane is exempt: it
  stays a target whatever its status.
- **Unnamed panes.** Nothing to resume under, nothing to rename to.
- **Agents whose live native session id herdr cannot see.** Reported as
  failed; not stopped or restarted, since there is no session to resume.

An agent may restart itself, including the one that invoked the command: a
real run with the invoking pane among its targets hands itself to a detached
process in its own session, so the run does not depend on the harness it
stops. The invoker is still recognised there and still ordered last, after the
Regent. A live agent that has no
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
throne restart-harnesses --only stager-west --only regent
```

## What each kind of run prints

### A real run with the invoking pane among its targets

The command returns at once and exits 0 whatever the agents' outcomes turn out
to be. It prints one line, and the path in it is `~/tmp/restart-harnesses.log`:

```text
restart-harnesses: continuing in a detached run; read <log>
```

### The log of that detached run

Each run appends a section to the log, opening with its header and ending with
its closing line. The `skipped` lines for unnamed and working panes come first,
then each target in restart order. The stopping line comes just before the
invoker's own lines. A `restarted` line also names any change of model or
effort.

```text
=== restart-harnesses run <time> <arguments> ===
restart-harnesses: skipped   <name> — <reason>
restart-harnesses: failed    <name> — <reason>
throne-startup: resume "<name>" — relaunched into its exact native <harness> session <session>; its own transcript is intact
restart-harnesses: restarted <name> — resumed native session <session>; running <binary>
restart-harnesses: stopping the invoking harness's own pane (<pane>) to restart it — this is the last target
restart-harnesses: finished — <count> restarted, <count> skipped, <count> failed
```

A header with no closing line under it means the run died or is still going.

### A foreground run

A real run that does not include the invoking pane (`--only` someone else, or
no pane at all) stays in the foreground. It prints only the agents' lines, with
no header and no closing line, and writes no log. Its exit code is the verdict:
0 when nothing failed, 1 when any restart failed, 2 on a bad argument. Read both
streams, because `failed` lines and the `skipped` lines for unnamed and working
panes go to stderr.

```text
restart-harnesses: skipped   <name> — <reason>
restart-harnesses: failed    <name> — <reason>
throne-startup: resume "<name>" — relaunched into its exact native <harness> session <session>; its own transcript is intact
restart-harnesses: restarted <name> — resumed native session <session>; running <binary>
```

### A dry run

A dry run stays in the foreground and changes nothing. It prints only the plan,
with no header and no closing line, and writes no log. A `restarted` line here
is a prediction: it says `would stop pane`. A `failed` line names an agent the
real run would fail, yet the exit code stays 0, so read the lines rather than
the code. A bad argument exits 2.

```text
restart-harnesses: skipped   <name> — <reason>
restart-harnesses: failed    <name> — <reason>
restart-harnesses: restarted <name> — would stop pane <pane> and resume session <session> (dry run)
```

## After running it

An agent that restarted itself reads the log once it is relaunched: its own
line is the last before the closing line. Any `failed` line is the run's
verdict on that agent, including one that came back on a binary other than
the vendored one. `throne agent-statuses` must list every restarted agent LIVE
under its own name, including the invoker and the Regent.
