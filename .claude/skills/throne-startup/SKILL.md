---
name: throne-startup
description: This throne-only skill boots the court after an install or Regent resurrection, and diagnoses and heals a throne whose SessionStart hook (`throne-cli throne-startup`) or Regent seating went wrong — a headless court after reboot, a hook that timed out, a stranded `stager-floor` worktree, "a branch named 'stager-floor' already exists", pane writes failing with `spawn flock ENOENT`, or messages sitting undelivered. Invoked by /throne-startup, or when the Lord says "the court is headless", "the startup hook died", "the Regent never came up", "stager-floor is stuck", "messages aren't being delivered", or "heal the startup", and by install.sh's install order to a freshly raised Regent. Distilled from the Regent's 2026-09-02 startup log.
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension throne-startup` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Throne startup: diagnose and heal

What `throne-startup` does when it works: the SessionStart hook in
`.claude/settings.json` runs the INSTALLED global CLI (`~/.local/bin/throne-cli`
or `~/bin/throne-cli`, planted by `install-services`), which resolves its own
herdr pane, no-ops outside the throne root, renames an unnamed pane to
`Regent` only if no Regent exists, banners the Regent desired-state
(`RUNNING`|`DISMISSED`), prints the QUEUE digest, and ensures the heartbeat.
It always exits 0 — so a broken startup is SILENT unless you look. This skill
is the looking.

The hook does not raise the court. throne-backend's `court-liveness` worker
does, once when the backend starts and every minute after: a missing Regent
becomes a `regent-resurrection` item on the durable queue; once the Regent is
live, a missing Stager is brought back from the newest registered dead Stager
(same name, worktree and session), or created through the Stager floor when
none can be reused. A `dismissed` desired-state keeps the court down, and
three failed checks in a row notify the Lord once.

Run every step from your own cwd with the `throne` on PATH; never `cd` into
the live root to reach the CLI.

## 0. Boot (a freshly raised Regent — install.sh sends you here)

Do these in order, in your own session, before any diagnosis:

1. Read `AGENTS.md`.
2. `npm start -- consume-fence-handoff-on-start`
3. `throne render-queue`
4. `throne agent-statuses` — confirm a live Stager. The backend's
   `court-liveness` worker raises one within a minute of your going live; if
   none is live after two minutes, go to the `stager-floor` row of the table
   in step 2 below.
5. Reconcile any in-flight campaign from durable ledger state (not process
   presence), then dispatch the next dependency-eligible queued objective.
6. Report outcomes to the Lord. Never put questions to him.

If every step passed, you are done; the rest of this skill is for when one
did not.

## 1. Establish what is actually wrong

```bash
throne list-agents                      # is there a Regent? a Stager?
cat ~/.throne/data/regent/spawn-marker  # desired-state: running|dismissed
throne queue                            # is the queue readable?
sqlite3 ~/.throne/message-queue.sqlite3 "select * from delivery_failure_notices order by rowid desc limit 10"
sqlite3 ~/.throne/message-queue.sqlite3 "select id,kind,state,failure_reason from work_items order by rowid desc limit 20"
```

`delivery_failure_notices` names the real reason a message did not land;
`work_items.failure_reason` is NULL while an item is merely yielding, so a
NULL there is not "fine".

## 2. Match the symptom to its known cause

| symptom | cause | remedy |
|---|---|---|
| No Regent a few minutes after a reboot | the backend's `court-liveness` worker only ENQUEUES a `regent-resurrection` item, at start and every minute; throne-backend's `sqlite-queue-drain` spawns it. Either the backend is not running, desired-state is `dismissed`, or the check itself is failing (it logs each failure and notifies the Lord after three in a row) | read the throne-backend log for `court-liveness`, then `throne keep-going` (honours `dismissed`). Do NOT use `summon-regent` for anything automatic: it overwrites desired-state to `running`. |
| Hook "timed out" on the first spawn in a worktree | the hook pointed at `${CLAUDE_PROJECT_DIR}/bin/throne-cli`, whose shim lazily `npm install`s + builds on first use and blows the 10 s hook timeout | the tracked `.claude/settings.json` must exec the installed global CLI first; if a worktree's copy differs, that worktree is stale — rebase it. |
| `a branch named 'stager-floor' already exists`, `~/.throne/data/stager-floor/` empty | a Stager-floor spawn died midway and stranded a clean worktree + branch + empty ledger dir; `spawn-git-tree` has no reuse path | `git -C <live-root> worktree remove ~/.throne/worktrees/throne/stager-floor && git -C <live-root> branch -d stager-floor && rmdir ~/.throne/data/stager-floor`; the next `court-liveness` tick raises the Stager within a minute. Confirm the ledger dir has no `identity.md` before removing it; one that does is a live agent, not debris. |
| Every pane write fails `spawn flock ENOENT` (macOS) | stock macOS ships no `flock`; the recipient-pane mutex spawns it | `brew install flock` (discoteq, arg-compatible). `install.sh` does this now; a machine installed before 2026-09-02 may not have it. |
| Deliveries wait the full 15-min lane bound on the mac | herdr `pane process-info` reports claude's MCP child as `{name:"node", argv0:"mcp-context-work"}` with no argv — the old parser rejected the whole pane | fixed in the parser (`e546976`); if it recurs on a newer herdr, capture `herdr --session throne pane process-info <pane>` as evidence before touching the parser. |
| "DEGRADED COURT" on every enqueue; even `regent-resurrection` starves | one delivery yielding on a resident human draft re-dued every second while the drain claimed oldest-first and only heart-beat on idle ticks | fixed in `e546976` (heartbeat every tick, non-message kinds every tick, never-scheduled first). If the banner shows anyway, find the yielding item in `work_items` and check whose pane holds an unsent draft. |
| A phantom DEAD agent named `install` | a `send-agent --sender-name install` created `~/.throne/data/install/` | harmless; registry enumeration needs `identity.md` or a completion report, so it never lists. Leave it. |

## 3. Things that look like bugs and are not

- `send-agent` has NO `--validate-only` flag, whatever the comment in
  `send-agent-input.ts` says; the text is sent.
- The Stager floor deliberately gives the Stager a worktree at
  `~/.throne/worktrees/throne/stager-floor` while CLAUDE.md says the Stager
  works in the live checkout. Both are true today; it is an open
  contradiction flagged to the Lord on 2026-09-02, not something to "fix"
  from either side during a startup repair.
- Bare `node --test test/x.test.ts` fails on decorator syntax. Use
  `node --import ./test/register-typescript.mjs --test --test-reporter=tap <file>`.

## 4. Prove it healed

`throne list-agents` shows a live Regent and a Stager; a `throne send-agent
Regent "startup probe"` lands (no new `delivery_failure_notices` row); the
QUEUE digest prints on the next hook run. Report exactly which row of the
table fired and what you ran; if none matched, say so and hand the evidence
from step 1 to the Regent rather than inventing a remedy.
