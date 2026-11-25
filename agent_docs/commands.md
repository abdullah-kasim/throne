# Command reference

Every concrete, repeatable action is a `throne-cli <command>`. Bare
`throne-cli` means **the live court**; `./bin/throne-cli` means **this
checkout**. Use bare form for court-state, plan, and routing questions. Use
relative form for candidate CLI and self-update validation. Both forms are
deliberate authorities; never mechanically rewrite one to the other.
Commands run the compiled `dist/` build (`bun run build`) on the Bun
pinned in `mise.toml`, the single place to bump it (see README.md). All commands
resolve agents by their unique herdr **name** and fail loudly (non-zero,
sending nothing) on a zero-or-ambiguous match — the reliability rule.

## Command summary

| Command | Purpose |
|---------|---------|
| `assert-herdr` | Refuse to run unless inside a herdr session. |
| `my-state <state> [--by <child>]... [--agent <name>] [<words>]` | Declare the caller's state (`working`, `blocked`, `waiting-on-own-run`, `waiting-on-supervisor`, `reapable`) in `~/.throne/data/<agent>/state.json`, written to a temporary file and renamed. `--by` names each child a `blocked` agent waits on; the words are what a waiting agent waits on, or the reason a `reapable` agent gives (`completed`, `abandoned`, `task_restart_required`, `fail`). Every check that asks an agent's state reads this file, never the pane. An agent may declare by command or by marker: `my-state --turn-end` reads a turn's final message on stdin and, when it carries a marker line (`{"blocked":true}` with `__BLOCKED_BY_<child>__` or `BLOCKED_BY_own-background-run (<what>)`, or `{"reapable":"<reason>"}`), writes the matching state as `declaredBy: agent`; Claude's turn-end hook calls it, Codex has no such hook. When a turn has both the command and a disagreeing marker, the command wins. Only the Regent may pass `--agent` to write another agent's file, recorded as `declaredBy: regent`. An Alpha that declares itself `reapable` with the command (not by marker, not through a Regent `--agent` write) queues one message to the Regent: `<alpha> declared itself reapable (<reason>). Its report: <data folder>/REPORT.md. Before reaping, confirm its commit is on the recorded target branch; if it is not reapable, tell it to continue.` Declaring the same reason again sends nothing; a Shadow, Stager or Regent sends nothing. When the message cannot be queued the state is still written, stderr says `my-state: the Regent was not told: <why>`, and the command exits 0. An unknown state is refused. The turn-start hook writes `working` at each prompt. `waiting-on-own-run` takes `--remind-in <minutes>`, a whole number from 5 to 60 kept in state.json (refused, writing nothing, outside that); the agent is reminded every that many minutes, 15 when none was given, and woken once when nothing it started is still running. |
| `agent-statuses` | Table of every herdr agent + its status (idle/working/blocked). |
| `scratch-pane register <pane> --owner <agent> --until <ISO-8601 time>` | Record that a live agent owns an unnamed herdr pane it opened on purpose until a time, so no-idling's unnamed-agent sweep stays silent about it; the sweep reports it once when the time passes and once when the owner is gone. Refuses an owner that is not a known agent and a time that has passed. |
| `agent-logs <name> [--lines N] [--source visible\|recent\|recent-unwrapped]` | Read what an agent has been doing (its recent/visible output). An Alpha uses it for one completion review, an explicit blocker, or silence beyond the 30-minute Regent heartbeat interval; the Regent uses it for diagnostics and to answer the Lord without blocking. It is never an Alpha short-cadence polling loop. |
| `send-agent <recipient-name> <prompt...> [--sender-name <name>] [--key <key>] [--clear-blocked]` | Send to a uniquely resolved recipient through the SQLite-backed delivery queue. `--clear-blocked` explicitly clears the recipient's durable blocked marker as part of this send, independent of message content. Delivery is the platform primitive — `herdr agent prompt <recipient> <body> --wait --timeout <ms>` owns the write, the Enter, and its own queue semantics; the throne keeps only its value around it: unique recipient resolution, sender attribution wrapped in tags carrying the queue id (`<message<id>>` newline `<sender> said: <prompt>` newline `</message<id>>`, so a message whose head or tail is clipped in the pane still shows the id to re-read it by: a missing opening tag means the head was cut, a missing closing tag the tail), the per-recipient pane mutex with identity re-proof under the lock, draft protection, file-backed payloads at 768 bytes and above (pointer + `read-payload` consumer), typed evidence, and durable receipts. Platform outcomes map to the throne's verdicts: a refusal before any write (`agent_not_found`/`agent_not_ready`/`empty_agent_prompt`/`agent_prompt_failed`/a command that never ran) is typed not-sent and retry-safe; a settled recipient state is delivered/queued evidence and records the supervision event; `agent_prompt_stalled`, `timeout`, `agent_not_running`, unknown codes, and unparseable successes assume filled — never resend. Inspect first, retry only typed not-sent, and never resend an assumed-filled verdict. On acceptance, `send-agent` prints the SQLite work-item id to check with `message-status <id>`; every accepted send is also unconditionally, best-effort recorded to `$THRONE_DATA/<senderName>/sent-messages.jsonl`, one JSON line per send (`{"timestamp": "<ISO 8601>", "recipient": "<name>", "id": "<the printed id>", "transport": "sqlite"}`). A ledger write failure never fails or delays the send. |
| `mcq --agent <name> (--answer <n> \| --dismiss) [--dry-run]` | Answer or dismiss the interactive prompt (a harness permission menu or a numbered question) held up in a named agent's pane. Regent or Stager only. Refuses when no prompt is visible or `<n>` is not offered; presses the digit first, falls back to Up/Down and Enter with a cursor check after every press, and pages the Regent to take over by hand when the cursor is not where expected. `--dry-run` prints what it would press. Appends to `~/.throne/data/regent/mcq-answers.jsonl`. |
| `send-agent-legacy <recipient-name> <prompt...> [--sender-name <name>] [--key <key>] [--clear-blocked]` | Reach for this only when `send-agent`/`queue-health` indicate the queue or `throne-work` server is broken and an immediate synchronous send is needed. A fully independent fallback: it shares no code, no failure mode, and no dependency with the queue, `throne-work`, the SQLite store, or the heartbeat — it delivers directly through the same platform primitive (`herdr agent prompt <recipient> <body> --wait --timeout <ms>`), with the same recipient/sender resolution, per-recipient pane mutex, draft-clearance wait, file-backed payloads, and typed not-sent/assumed-filled verdicts `send-agent` had before it became a queue enqueue. It is never the default path — only the manual recovery route when the new path is confirmed unreachable. It does not write to the `sent-messages.jsonl` ledger. |
| `message-status <id>` | Checks whether a message `send-agent` accepted actually delivered. A numeric `<id>` reads the SQLite `work_items` path (`readWorkItem`) and prints `unknown-id`/`queued`/`in-flight`/`delivered`/`failed: <reason>`; it exits `0` on a resolved verdict, `1` on `unknown-id`, `64` on a usage error, and `69` when the REST transport is unreachable. SQLite `queued`/`in-flight` verdicts report heartbeat staleness. Use this against the id `send-agent` printed, or against a past id read back from `$THRONE_DATA/<senderName>/sent-messages.jsonl`. |
| `read-message <id>` | Prints the stored text of one queue-delivered message to stdout as `<senderName> said: <prompt>` (just `<prompt>` when the stored payload has `omitSenderAttribution` true) and exits `0`. It only reads: it never changes or deletes the row, so running it twice gives the same output. An unknown or already-swept id exits nonzero with one line saying the message is no longer stored (rows are swept 2 days after they finish). A caller who is neither the row's `recipientName` nor its `senderName` is refused with a nonzero exit. Run it on the id in the surviving tag of a message missing its opening or closing tag, or when a notice names that id (see "A message missing a tag: re-read it by the id in its tags"). |
| `read-payload <absolute-payload-path>` | Primary consumer for a file-backed large message. It accepts only an absolute `.payload.txt` directly under `~/.throne/payloads`, reads the complete bytes before attempting deletion, prints the exact body to stdout only when deletion succeeds, and emits the byte count plus SHA-512 receipt to stderr. Missing, unreadable, cleanup-failed, invalid-path, and usage outcomes are distinct nonzero exits; a failed/partial read never deletes. |
| `notify-lord <message...>` | Send one deliberate Lord-facing message through the configured tailnet-only ntfy transport. Arguments are single-space joined and trimmed; an empty message is rejected before any POST. A valid message is awaited exactly once with title `Message from the throne`. This is an intentional external side effect, not a hidden progress-log channel. |
| `spawn-git-tree <name> [--repo <path>] [--base <ref>] [--alpha <name>] [--non-campaign]` | Create a git worktree for a target repo (`--repo`, default: the throne's own; omission warns loudly, so cross-repo campaigns must pass it), placed under `~/.throne/worktrees/<repo-basename>/<name>` — OUTSIDE the target repo. **The base depends on the tree kind.** A **campaign Shadow** name (`shadow-<code>-…`) bases on its supervising **Alpha's branch** (the branch whose name equals the Alpha agent name), resolved from the objective code carried in the name or an explicit `--alpha <name>`; its `tree-base.json` records that branch as the merge target. Every other name — Alpha trees, infrastructure — bases on the target repo's current branch+commit (or `--base <ref>`). `--non-campaign` is the one loud override: current-branch basing for a deliberate `shadow-*` infra tree. All validation runs before any write, so a missing, ambiguous, or invalid Alpha/branch refuses cleanly — no worktree, no branch, no `tree-base.json`. All CAMPAIGN coding happens in a tree, never the live checkout; the Stager is the one exception: it commits directly in its own tree, outside any gate chain, and the prompt hook keeps that tree current with `main` (see "The Stager"). |
| `merge-git-tree [--data-dir <path>] <name> <message>` | Merge a tree's branch back into its **recorded base branch** (`tree-base.json` `branch`) in its **recorded** target repo (both read from `~/.throne/data/<name>/tree-base.json`; repo falls back to the throne when unrecorded) — the other half of `spawn-git-tree`. A Shadow thus lands in its Alpha's branch, the Alpha's branch lands in the target branch. **Transport is flexible; the destination is not**: the command lands at the root checkout when the recorded branch is current there, inside the registered worktree that has it checked out (normally the Alpha's own tree), or — when the branch is checked out nowhere — via a temporary worktree it creates and removes, so an un-checked-out target is never a failure. Success means the intended content is on the recorded branch, never that one particular git ceremony ran. Wraps `mergeBack` (stash → merge → unstash → resolve); a real merge conflict aborts + throws for hand-resolution. The one refusal is fail-closed metadata: an absent/legacy `tree-base.json` with no usable `repo`+`branch` refuses because the target cannot be known safely — that refusal is a **campaign metadata/process defect to repair** (fix the record or the process that failed to write it), never a prompt to guess a branch or bolt on another merge validator. So merging back never needs raw git. |
| `validate-delivery <repo-path> <commit-hash>` | Ledger-free delivery proof: opens the repo at `<repo-path>`, reads its CURRENT checked-out branch (never a recorded/ledger branch), and reports a typed `delivered` \| `not-delivered` \| `unknown-commit` \| `invalid-repo` verdict on whether `<commit-hash>` and that branch's tip carry identical Git trees, naming the branch and both compared tree IDs. Reports target working-tree status (clean/dirty) alongside the verdict; a dirty tree never by itself flips the verdict. Takes only the two positional arguments — no agent name, no `tree-base.json` read — so it can be pointed at any repo including one the throne has never heard of. Reuses `verify-delivery`'s shared revision-tree identity primitive. It is a ledger-free sibling of `verify-delivery <alpha-name>` (agent-name-keyed and fail-closed on missing provenance); both prove squash-compatible content identity from different inputs. |
| `push-waiver --repo <dir> --remote <name> --ref <local branch> --findings-file <file> --entries-file <file>` | Record the pushing agent's proof that every finding a blocked push check reported is not a defect in its branch (`other-open-pr`, `already-on-base` or `finding-wrong`, each with validated evidence) as a waiver under `~/.throne/data/<agent>/push-waivers/`, and print the one `git push --no-verify` command the `bin/git` guard then admits once for that commit, branch and remote. See `agent_docs/commands.md`. |
| `create-agent [--model <m>] [--effort <n>] --name <name> --supervisor <name> [--escalation <name>] [--role <role>] [--cwd <path>] [--prompt <text>] [--model-hint <harness/model>] [--objective-code <code> \| --non-campaign] [--empty-worktree] [--single-slice] [--bypass-model] [--bypass-effort] [--bypass-preset-agent] [--bypass-zero-quota] [--bypass-opencode-telemetry-unavailable] [--harness-executable <absolute-path> [-- <complete harness argv…>]] [--run-custom-harness-to-exit --bypass-run-custom-harness-to-exit …]` | Spawn a registered agent after the shared admission resolver confirms a mechanically spawnable requested pair and the applicable preset pool, role pin/allowlist, queue `model_hint`, or durable human exception. The resolver never chooses a stronger substitute or retry ladder. **`--harness` is NOT caller-selectable** — passing it is a hard refusal (`create-agent: --harness is no longer caller-selectable; infer the harness from the canonical model registry by passing --model.`); the harness is inferred from `--model` through the canonical registry. Without `--model`, the agent launches on the first model of its role's active pool (`list-harnesses-and-models --json` → `active_plan.rolePools.<role>`), exactly as if that model had been named; a role with no pool is refused. A nullable `--model-hint` records human queue intent, persists on an Alpha, and inherits only to its recorded campaign descendants; it must match `--model` and can never substitute it. Existing migration routes remain available until deliberate retirement. Exact registered resumes retain their stored recipe. Fresh campaign Alphas and Shadows must launch from their matching throne-managed external Git worktree, or use explicit `--empty-worktree` to create a matching managed scratch workspace with generated `AGENTS.md`; no treeless launch exists. Inspect `list-harnesses-and-models` for current pairs, preset, effort ranges, and launcher route. For the Regent-authorized campaign allowlist edit, exact JSON shape, fallback behavior, and same-user trust boundary, see `agent_docs/MODEL_POLICY.md#campaign-model-allowlist-operator-override`. See `agent_docs/commands.md`. |
| `derive-shadow-name-from-alpha <alpha> <slice-id>` | Read the supervising Alpha's durable campaign evidence and print the complete canonical descendant handle. Campaign workflows reuse that exact result for the Shadow's tree, agent, ledger, monitoring, merge, and reap; callers never copy an objective code into a Shadow name. |
| `reap-agent <name> --reason <enum> [--force] [--archive-abandoned-unmerged] [--spawn-process-gone]` | Tear an agent down through the tooling: close its herdr tab, remove its worktree (`git worktree remove`), and archive its `~/.throne/data/<name>/` → `~/.throne/data/.reaped/<name>/`. Before archiving, it records `reaped_at` + `reap_reason` and appends the timing row to `~/.throne/data/stats/agent-timings.jsonl`; `--reason` is REQUIRED. Ordinary reap accepts `completed|completed-unpublishable|stalled|force|orphan|superseded|error|abandoned|scratch|other`; `--reason abandoned` alone runs ordinary teardown and still refuses a branch carrying content that cannot be proven delivered. Abandoned is final: a reap never reopens a queue row, so `--reason abandoned` leaves a queue-linked row `abandoned` and the autoscaler never launches it; reopening is a separate explicit act, `update-queue --objective-code <code> --status open`, by the row's filer or the Regent. `--reason scratch` marks a disposable diagnostic probe that completed no real work (e.g. a send-agent canary target); `agent-stats` excludes `scratch` rows from its completion/stall breakdowns entirely, distinct from `completed` (a real completion) and `other` (neither of the above). The abandoned-unmerged archival form is `reap-agent <name> --reason abandoned --archive-abandoned-unmerged` — `--archive-abandoned-unmerged` requires `--reason abandoned`, but not the reverse. It retains the exact intentionally-unmerged local ref/tip and moves byte-identical provenance to `tree-base.abandoned-unmerged.json`; it never merges, deletes, renames, or makes that branch name reusable. A `--force` reap carrying any other `--reason` (e.g. `completed`) that cannot prove delivery is retained through the same mechanism but reported as `UNMERGED-RETAINED`, not `ABANDONED-UNMERGED` — the timing row still records the caller's actual `--reason` untouched, so `agent-stats` is unaffected; only the human-facing label and archival vocabulary differ from the explicit `--reason abandoned --archive-abandoned-unmerged` form. `--force` remains only the live-child/liveness override; agent memory lives outside every worktree (`memory-dir`), so reap has nothing of it to protect. A successful `--reason completed` reap notifies completed Alphas by default; set `THRONE_NOTIFY_SHADOWS=1` to opt Shadows in too. Ordinary reap is idempotent when the lifecycle is already gone; explicit abandoned-unmerged archival instead requires live `tree-base.json` or preserved `tree-base.abandoned-unmerged.json` authority until archival succeeds, so rerunning it after successful archival is not the ordinary already-gone no-op. Initial abandonment proof refuses delivered, missing, corrupt, mismatched, foreign, or duplicate-checkout authority before tab/worktree/ledger mutation; a ref move after preflight is detected only by post-teardown verification while the moved ref and preserved marker remain recoverable. Plain reap **refuses a LIVE agent** unless it is completion-proven (its `REPORT.md` landed and herdr no longer says `working`). Plain reap also refuses while live children still report to the target; `--force` cascades through those live children first and is the only path that may kill genuinely-working agents. Dead/complete agents reap freely. Refuses an agent whose spawn is still starting (spawn not finished, no opening prompt recorded, under 300 s old) even with `--force`; `--spawn-process-gone` states that its `create-agent` process is gone and permits the reap. Reaping a campaign Alpha (role Alpha with an objective code) with a reason that maps to a row status, when no in-flight row is recorded under its name, prints that the row was NOT released and exits 1 instead of `Reaped ...`; the teardown still ran. Read the row back with `render-queue` before reporting any release. Refuses the Regent outright. Ordinary cleanup first accepts commit reachability, then accepts squash-equivalent delivery only when recorded delivery evidence is retained by the recorded target and the candidate content carries the same canonical Git tree; cleanup repeats that authority check immediately before deletion. Unique, unequal, or unverifiable content remains protected and requires the explicit retention/discard path. See `agent_docs/commands.md` under reap-agent for the mechanism. See `agent_docs/commands.md` for abandoned-unmerged archival's strict proof and retry boundary, its cure for a failed autoscale launch, and `agent_docs/ntfy-phone-notifications.md` for the server/topic/operator contract. The teardown counterpart to `create-agent`/`spawn-git-tree` (E2/D2 build on it). |
| `complete-agent <name> \| --all` | Reap-on-complete: reap a **finished** agent only. Verifies E1's durable completion signal via `getRoster`, then delegates teardown to `reap-agent` (re-implements no teardown). Reaps both a gone COMPLETE agent and a completion-proven LIVE agent whose status is no longer `working`; preserves `reap-agent`'s live-child refusal/cascade gate; **refuses every other LIVE** agent and any **DEAD** agent (died mid-work, no report — a D2 orphan call); idempotent no-op on an unknown/already-reaped name; never reaps the Regent. `--all` sweeps COMPLETE and completion-proven stuck agents, failure-isolated. **Commit-before-report is machine-gated, not merely instructed:** both `complete-agent` and plain `reap-agent --reason completed` (no `--force`) run `checkOwnWorktreeCommittedPrecondition` (`src/slice-evidence/agent-evidence-gate.ts`) before accepting the agent as done, and refuse when its own recorded worktree still carries uncommitted **tracked** changes (staged, modified, or deleted files already known to git) — untracked debris (a scratch note, a stray `node_modules`) never trips it. The refusal names the concrete remedy (`git add -A && git commit`) and the agent's own branch. Three cases are exempt, each its own distinguishable outcome rather than a shared silent pass: `deliverable_shape: "verdict-only"` agents (a verdict gate produces no diff by design), `isTerminalDeliveryShadowName` (`99b`, or legacy `99e`) agents (their content lands via their supervising Alpha, not their own branch), and agents with no resolvable `spawn.json` cwd / `tree-base.json` branch (nothing to check against). **Honest limit:** this does not recover uncommitted in-progress work lost before a commit — it only prevents an agent from being accepted as COMPLETE while committed-but-unreported work still sits on disk. `--force` still tears the agent down over a dirty tree but prints a loud warning naming what was skipped instead of silently skipping it. |
| `keep-going` | Background nudge: without `--name`, read the Regent's desired state, resolve the uniquely named live Regent, and route the queue-aware nudge through the same sender-aware submit engine with explicit non-agent origin `keep-going`, yielding `keep-going said: run render-queue, queue and dispatch more work as necessary, check for stalled agents and poke them, and continue any active work`. If the Regent is dismissed, do nothing. If no live Regent exists while desired state is running, resurrect one instead of sending, without reading any provider sensor. With `--name <agent>`, skip desired-state/resurrection and nudge that named agent; a named Regent gets the same queue-aware literal, while any other named agent gets the generic nudge. It never dispatches itself and exits non-zero only on genuine ambiguity or resolution failure. Whenever the target is the Regent, the exact live Regent harness label is the sole pacing selector: `codex` reads only Codex quota, `claude` only Claude quota, `opencode` only the opencode-go sensor, opposite-provider telemetry cannot change cadence, a harness change or legacy driverless state starts a fresh pacing domain, and a label outside `HARNESSES` reads no provider getter and nudges unthrottled with an explicit diagnostic. A throttle-evaluation failure nudges unthrottled (NORMAL); a state-read failure can still compute a matching non-NORMAL band; a state-write failure can retain a computed non-NORMAL band — no failure ever suppresses the heartbeat. Output is byte-identical to the pinned literal only when the evaluated band carries no advisory. |
| `add-to-queue [--objective-code <code>] [--effort <level>] [--single-slice] <body words...>` | Add a new `open`-status item to the SQLite-backed Regent queue store (`src/regent-queue/`). `--single-slice` (Stager, on the Lord's own word, or under his standing ruling for a read-only artefact row, filed with `--model-hint claude/opus` too; /queue-objective has the class) makes the campaign one implementation slice `01`, one executor Shadow and the ordinary `99` gates as fresh Shadows; the autoscaler forwards it as `create-agent --single-slice` (/execute-todos "Single-slice mode"). `--shadowless` and `--sliceless` are refused, removed by the Lord on 2026-11-04. `--model-hint <harness>/<model>` outside the Alpha pool records the Lord's order as a recipient-`*` authorization in both Regent bypass registries and puts the pair in the Alpha's model allowlist, so the autoscaler launches it with no Regent step (agent_docs/commands.md, add-to-queue). `--effort <1-6 \| low \| medium \| high \| xhigh \| max>` (Stager, on the Lord's own words only) stores the campaign's reasoning effort on the row, names mapping to the launch numbers `low` 1, `medium` 2, `high` 3, `xhigh` 4, `max` 5; the autoscaler forwards it as `create-agent --effort <n> --bypass-effort` and every Shadow of that Alpha inherits it with no flag. |
| `update-queue --objective-code <code> <field flags>` | Replace the body or correct status and lifecycle provenance on an existing queue item. Nullable provenance fields have explicit `--clear-*` flags. `--effort <level>` sets the row's campaign effort and `--clear-effort` removes it. |
| `reconcile-queue --objective-code <code> --absorbed-by <campaign> --delivery-commit <commit>` | Close work delivered by another campaign and record the absorbing campaign and delivery commit. |
| `trim-queue [--apply]` | Remove terminal (`complete`/`abandoned`) items from the SQLite-backed Regent queue store. Dry-run by default (reports what would be removed); `--apply` performs the removal. A non-terminal (`open`/`in-flight`) item is never removable regardless of flags. |
| `ensure-heartbeat` | Idempotently arm the keep-going timer: render the `throne-keep-going` service+timer sources into the systemd user unit dir as real files through the same shared install core `install-services` uses, then `daemon-reload` + `enable --now` — so no operator runs `systemctl --user enable --now` by hand. It owns the keep-going pair only; because both commands render the same sources with the same tokens into the same paths, whichever runs second finds byte-identical content and writes nothing. Degrades gracefully where systemd is unreachable. |
| `install-services [--dry-run] [--offline] [--throne-root <absolute path>]` | Acquire and verify the pinned herdr client, install the public `throne` seam, and render/install the throne's hooks and services, including the herdr service for the isolated named `throne` session. Installing never touches or restarts a running server; explicit handoff remains separate. Sources carry `{{THRONE_ROOT}}` or `{{HERDR_BIN}}` substitutions and leftover tokens are refused. **NO-CLOBBER** — installation never issues `restart`/`stop`/`kill` on linux nor `bootout`/`kickstart`/`kill` on mac; changed live units are reported for a deliberate between-runs handoff. It also registers every throne Claude Code hook listed in `claude-hooks/hooks.json` in `~/.claude/settings.json`, among them the guard `claude-hooks/scratch-path-guard.py` (refuses Bash writes and removals under `/tmp` or at the filesystem root, steering to the literal home `tmp` directory; see `agent_docs/commands.md`). It turns off herdr's own agent resume in the herdr config and adds the throne shell block, guarded on `HERDR_SESSION=throne`, to `~/.bashrc` (through its symlink) beside a rendered `shell/throne-session.bash`. `--dry-run` prints the plan and mutates nothing; `--throne-root` changes only paths baked into rendered artifacts. |
| `throne-startup` | SessionStart-hook entry point: self-configures a fresh throne harness — renames an unnamed top-level harness to `Regent` (and claims its herdr **tab** as `Regent`, self-healing a stale label) and runs `ensure-heartbeat` — full no-op outside the throne top-level harness. |
| `agent-stats` | Report trailing-7-day stall rate and average completion by harness from the agent timing log, with by-role and reap-reason breakdowns; `--json` emits machine-readable output. |

## assert-herdr

```bash
./bin/throne-cli assert-herdr
```

Preflight gate. Exits `0` and prints a confirmation when running inside a live
herdr session; exits non-zero with a relaunch instruction otherwise. Presence is
detected by a successful `herdr pane current`. Run this first — every tier must
be on herdr.

## agent-statuses

```bash
./bin/throne-cli agent-statuses
```

Above the table it banners the Regent's declared **desired-state** —
`RUNNING` (the keep-going watchdog resurrects a dead Regent) or `DISMISSED`
(the Lord stood the court down; the watchdog will NOT resurrect) — so the
self-heal mode is never a hidden setting, and a stood-down court's empty roster
is self-explaining. The banner reads via `regentstate.ts`'s `readDesiredState`
seam (absent/garbage marker ⇒ `RUNNING`, fail-safe) and flips as the Lord runs
`dismiss-regent` / `summon-regent`.

Below the banner it prints a padded table of every herdr agent: `NAME`, `STATE`,
`STATUS`, `CWD`, `PANE`. The `STATE` column is one of **LIVE** / **DEAD** /
**COMPLETE** / **STARTING**. STARTING is an agent whose spawn is still
running with no opening prompt recorded and under 300 s old (see reap-agent);
it shows whether or not herdr already lists it. Otherwise a registered agent whose herdr process is gone but whose todo
bundle finished (its `~/.throne/data/<name>/` carries a `REPORT.md`) is COMPLETE
(reap-ready), as opposed to DEAD (registered, process gone, no completion
report). The `STATUS` column (`idle|working|blocked|done|unknown`) is meaningful
only for LIVE agents. The focused agent is marked with `*`; unnamed agents show
their default label in parentheses (e.g. `(claude)`).

## agent-logs

```bash
./bin/throne-cli agent-logs <name> [--lines N] [--source visible|recent|recent-unwrapped]
```

Prints the named agent's recent on-screen / emitted output — the monitoring eye.
`--lines` caps the number of lines (positive integer). `--source` selects what
herdr returns (default `recent`). Exits non-zero if the name resolves to zero or
more than one agent.

## send-agent

```bash
./bin/throne-cli send-agent <recipient-name> <prompt...> [--sender-name <name>]
```

Resolves the recipient uniquely before any sender lookup or delivery. By
default, the sender is the invoking pane's unique canonical live agent name;
`--sender-name` supplies an exact explicit identity, including stable non-agent
origins. The send formats the recipient-visible row as
`<message<id>>`, a newline, `<sender-name> said: <prompt>`, a newline and `</message<id>>`
(a missing opening tag means the head was cut, a missing closing tag the tail), and delivers that logical body through the
platform primitive.

Delivery is `herdr agent prompt <recipient> <body> --wait --timeout <ms>` — the
platform owns the entire write-and-Enter transaction and its queue semantics.
The throne retains only its own value around that call:

- **Recipient mutex and identity proof.** One lock row in `locks.sqlite3`, keyed by
  the initially resolved recipient pane id, is taken before anything else.
  Under the lock the original unique name is re-resolved and must still name
  the same pane, terminal, and harness; acquisition failure or identity drift
  returns typed not-sent with zero delivery effects. Same-pane processes wait
  serially while different pane ids remain independent. A row whose holder
  process has exited, died of a signal, or been replaced by another process
  with the same id is deleted by the next taker.
  The lock expires after a minute (`PANE_LOCK_MAXIMUM_HOLD_MS`): the holder
  writes its start time and process id into the lock row, and a sender that
  finds the lock held waits until it is a minute old or released. At a minute
  it takes the lock over: it presses the forced Enter on whatever sits in the
  box (refused only by a dialog), writes its own start time, logs the pane, the
  old process id and the lock's age, and delivers its own message. The old
  holder checks it still owns the lock before every write and every Enter;
  once displaced it stops, and its delivery fails as "taken over after a
  minute" and is never retried.
- **Draft protection is absolute.** Before the platform call, the throne reads
  the recipient's composer once. `herdr agent prompt` writes straight into the
  composer and presses Enter — it does not queue behind a resident draft — so a
  resident draft would be merged into and submitted with the sent text. The
  throne therefore refuses (typed not-sent, nothing written) whenever the
  composer is not provably empty, unreadable, covered by a dialog, or on a
  harness with no supported grammar. A human mid-sentence outranks every agent;
  agent traffic never types into or submits his draft.
  One exception, by the Lord's order of 2026-11-12: text left unchanged for a
  minute in the box of an Alpha, a Shadow or the Regent is submitted by the
  no-idling sweep (see `no-idling`). Stager boxes keep this rule.
  `send-agent <agent> --enter-only` presses Enter once in the caller's own
  process: it reads the box once, refuses only a dialog or an unreadable box of
  a supported harness, takes and waits on no lock, types nothing and enqueues
  no work item. It prints one line and exits 0 on a press, or prints the
  reason and exits non-zero.
- **Opencode composer-emptiness contract.** The opencode reader
  (`src/composer/prompt-region.ts` `readOpenCodePromptRegion`) selects the
  bottom-most `┃` box closed by a `╹▀▀▀…` edge and reports these states as a
  PROVABLY EMPTY composer:
  - **in-session idle** — the model-status row, recognized by its leading
    shape `^Build(?:\s*auto)?\s*·` plus the `OpenCode Go` token and stripped
    whatever its suffix (` · max`, ` · high`, ` <cwd>:<branch>`);
  - **the cwd:branch artifact / wrapped path variants** — right-aligned
    wrapped path fragments beginning more than `OPENCODE_MODEL_PATH_COLUMN_OFFSET`
    (12) columns past the marker are dropped;
  - **the PRE-SESSION landing screen** — the `Ask anything...` placeholder
    line renders in truecolor neutral grey `38;2;128;128;128`, which the parser
    marks `muted` (`isNeutralGreyMuted`, a neutral grey r==g==b below the 200
    brightness limit in `src/composer/ansi.ts`), and an all-muted content line
    is skipped as placeholder chrome; any `● Tip` line below the box is outside
    the composer box and never content. The captured
    `test/fixtures/opencode-landing.ansi` and its synthesized Buildauto/Tip
    variants each classify `{state:'empty', text:''}`.
    A real resident draft — any bright (non-muted) character, e.g. typed input
    rendered near-white `238;238;238` — still classifies `draft`, refuses typed
    not-sent, and is preserved byte-for-byte (the long-transcript fixture's draft
    text is recovered exactly).
- **File-backed bodies.** The exact attributed UTF-8 payload is classified;
  bodies at or above 768 bytes are never sent through the prompt path: while
  still under the lock and after identity refresh, the throne stages the exact
  body in a unique `0600` file beneath the `0700` `~/.throne/payloads/`
  directory and submits only a short pointer (see below).
- **Typed outcomes.** The platform's own typed outcomes map to the throne's
  verdict contract: a platform refusal before any write (`agent_not_found`,
  `agent_not_ready`, `empty_agent_prompt`, `agent_prompt_failed`, or a command
  that never ran) is `SubmitNotSentError` — retry-safe, nothing was written.
  A settled recipient state (`idle`/`done`/`blocked`) is delivered evidence and
  records the supervision receipt. `agent_prompt_stalled`, `timeout`,
  `agent_not_running`, an unknown error code, or an unparseable success is
  `SubmitIndeterminateError` — text was written and may still be pending, so
  the caller never resends. The default settled-state wait is bounded by the
  throne's own timeout; `--timeout` beyond that is herdr's platform flag, not a
  send-agent option.

Exits non-zero and sends nothing when the recipient is absent/ambiguous or
required default sender inference fails. Only `--sender-name` is reserved;
other dash-prefixed tokens remain prompt text.

A Claude Code or pi recipient whose `spawn.json` records `delivery_socket`
gets the same body over that Unix socket instead of typed keys. The agent
listens (pi inside its extension, Claude through a helper the mod starts with
`bin/throne-runtime`) and throne connects: `POST /deliver` with
`{ id, pane, text, waitMs }` holds the connection until the agent answers
`delivered` (`as` `turn` or `followUp`, `repeat: true` for an id it
already delivered, with nothing submitted again), `busy` with a reason once
`waitMs` has passed, or `refused`. Connecting is bounded by 1000 ms and the
answer by `waitMs` plus 2000 ms. A socket that cannot be connected to, a busy
answer, or no answer types the message, once, with one fallback line. An
opening prompt (`waitForStartupQuiescence`) to an agent whose `GET /alive`
does not answer yet waits up to 20 s (`SOCKET_STARTUP_WAIT_MS`), pi and Claude alike, for it
before falling back to typing; any other message falls back at once. Every
other recipient takes the typed path above unchanged. Agents launched before
the socket keep typed keys until `/restart-harnesses` relaunches them.

`send-agent` intentionally has no harness-selection flag and remains unchanged;
the create-agent `--harness` denial applies only to launch requests, while
registered resumes preserve the harness stored in `spawn.json`.

### File-backed bodies and `read-payload`

The engine classifies the exact attributed UTF-8 payload. Bodies at or above
768 bytes are never typed into the composer: while still under the recipient
pane lock and after identity refresh, throne stages the exact body in a unique
`0600` file beneath the `0700` `~/.throne/payloads/` directory and submits only
a short pointer. Below-threshold bodies retain the direct composer path. Before
each large stage, `stagePayload` starts a stale-file reap without awaiting it;
a hung or failed pass cannot delay/fail the send, and failures are reported.

The pointer is one exact line and makes the throne-owned consumer primary:

```bash
Large message — read then delete: <JSON-quoted bin/throne-cli path> read-payload <JSON-quoted payload path>
```

The command accepts only an absolute `.payload.txt` directly under the throne
payload directory. It reads the complete file before deletion. On success it
prints the exact recovered body to stdout without decoration, prints an exact
byte-count + SHA-512 + deleted-path receipt to stderr, deletes the file, and
exits 0. Defined failures are:

- exit 2: `read-payload: payload missing at read time: <path>`;
- exit 3: `read-payload: payload unreadable at read time: <path> (<error>)`;
- exit 4: complete read succeeded but deletion failed; the body is withheld from
  stdout so nonzero never masquerades as successful consumption;
- exit 5: the path is outside the owned payload directory or has the wrong
  shape;
- exit 64: malformed invocation.

A failed or partial read never deletes. Recipient cooperation remains a soft
edge: throne can define the outcome once invoked but cannot force an LLM to run
the command. The backstop runs again from confirmed-Regent startup
`reconcile()`, where failure is warned, summarized, and isolated from orphan
reconciliation. The 24-hour TTL means eligibility, not an independent timer: an
unread file is removed on the first successful opportunistic-stage or Regent
startup reap after it expires. A fresh payload survives those passes.

`send-agent` classifies the exact attributed UTF-8 payload. At 768 bytes or
above it writes the body to an owner-only `0600` file under the owner-only
`~/.throne/payloads/` directory and submits only a short pointer through the
existing recipient-pane mutex and composer state machine. The pointer is one
line: `Large message — read then delete: <JSON-quoted bin/throne-cli path>
read-payload <JSON-quoted payload path>`. `read-payload` remains the primary
complete-read-then-delete route. Smaller bodies stay on the direct path.

Recipient cooperation is assumed: throne cannot force an LLM to invoke the
consumer. The backstop has two production callers. Every large staging attempt
starts an opportunistic reap before writing without awaiting it; failure is
reported and cannot fail or delay the send. The confirmed Regent's startup
`reconcile()` awaits another failure-isolated reap and records its result in the
boot summary. A file becomes eligible after the 24-hour TTL and is removed by
the next successful caller run; TTL alone is not a timer. A fresh file remains
protected, and failed/partial consumption never deletes.

The safe acceptance canary for the native gate is
`test/create-agent-native-quota.canary.test.ts`: it runs the actual `node
throne/src/tools.ts create-agent …` command with a scratch `HOME`, synthetic
OAuth credentials, an import hook owning the usage endpoint, a fake
first-in-`PATH` `herdr`, and fake native launchers reached through
`THRONE_LAUNCHER_DIR`. It must prove exhausted Fable refuses
with reset evidence and causes no registration, herdr mutation, real network,
or harness execution; cleanup runs in `finally`, including after failed
assertions.

Payload delivery has one shared platform-prompt boundary and one shared
cross-process critical section. Before its final preflight, every production
`submitToAgent` call takes a lock row in `locks.sqlite3` keyed by the
initially resolved pane id, then re-resolves the original unique recipient
name and requires the same name, pane id, terminal id, and harness. Acquisition
or identity drift fails typed not-sent before any delivery effect. Same-pane
producers wait serially; different pane ids use independent rows. The lock is
held through the draft-protection read, file staging when applicable, the
platform prompt call, and the delivered receipt, then its row is deleted in
`finally`. A row whose holder process is gone, or now has a different start
time, is deleted by the next taker. Ordinary sends
and both direct and systemd `keep-going` all inherit this section through the
common submit engine.

Delivery is the platform primitive — `herdr agent prompt <recipient> <body>
--wait --timeout <ms>` — which owns the write, the Enter, and its own queue
semantics. The throne performs no composer recognition, no clearance contracts,
no bounded-Enter loops, and no write/Enter key effects for submission; the
platform's own screen grammar and queue state machine replace them. The
throne-side ordering is the draft-clearance wait: because a write into a
non-empty composer would merge with and submit the resident text, the sender
observes the composer and waits for any resident draft to clear BEFORE
competing for the recipient lock — a draft is a wait condition, never an
error, bounded by the composer deadline and then typed not-sent with nothing
written. A human mid-sentence outranks every agent in the court; agent traffic
never types into or overwrites his draft. The one exception, by the Lord's
order of 2026-11-12: text left unchanged for a minute in the box of an Alpha, a
Shadow or the Regent is submitted by the no-idling sweep with the forced Enter,
which takes no lock; Stager boxes keep this rule. Lock acquisition settles exclusive
composer ownership: text present after acquisition is flushed — submitted
through the bounded Enter-until-empty transaction — and the payload then goes
through that same transaction exactly once; post-lock text is never a
release-and-retry condition, and the lock is held until the send transaction
returns its typed outcome.

The platform's typed outcomes map to the throne's verdict contract. A platform
refusal before any write (`agent_not_found`, `agent_not_ready`,
`empty_agent_prompt`, `agent_prompt_failed`, or a command that never ran) is
typed not-sent: nothing was written and the identical call is retry-safe. A
settled recipient state (`idle`/`done`/`blocked`) is typed delivered/queued
evidence and records the supervision receipt. `agent_prompt_stalled`,
`timeout`, `agent_not_running`, an unknown error code, or a succeeded-but-
unparseable command is typed indeterminate: text was written and may still be
pending, so the caller never resends. Receiver transcript and acknowledgement
remain useful post-hoc outcome evidence, but they never upgrade an
indeterminate verdict. The separate file-backed protocol retains its
complete-read-then-delete receipt integrity because it verifies file transfer,
not a terminal composer rendering.

### Operator recovery workflow

Inspect the active pane before choosing a delivery mode:

```bash
./bin/throne-cli agent-logs <recipient-name> --source visible
```

Confirm the intended payload and the recipient state. Run an ordinary send
only when the intended payload is not already resident; a resident draft is
preserved — the send refuses typed not-sent without touching it.

Retry the identical ordinary command only after `SubmitNotSentError`. Never
resend after `SubmitIndeterminateError`; inspect first and decide from observed
recipient state. For a subsequent busy message, report it as queued only when
the platform prompt settled with the recipient working on the queued turn, or
the recipient's transcript shows the accepted entry. A status change or an old
transcript occurrence alone is insufficient.

## mcq

```bash
./bin/throne-cli mcq --agent <name> (--answer <n> | --dismiss) [--dry-run]
```

Answers or dismisses the interactive prompt holding up a named agent's pane: a
Claude Code permission menu (`Do you want to proceed?` with `1. Yes` / `2. No`
and the hint `Esc to cancel · Tab to amend`) or an AskUserQuestion menu (hint
`Enter to select · ↑/↓ to navigate · Esc to cancel`). The detector lives in
`src/pane-prompts/detect-interactive-prompt.ts`; Codex draws no numbered
prompt the throne has seen, so `detectCodexInteractivePrompt` is an empty seam.
The same detector feeds the blocked-agent page: when a blocked pane shows a
prompt, the Regent's page carries the kind, the question, the quoted command,
any warning line, the options with the selected row marked, both clearing
commands, and the sentence "Regent: judge whether the command is safe before
answering." A blocked pane with no prompt keeps the older stuck message.

Only the Regent or a Stager may run it; an Alpha or Shadow is refused (exit 3)
and told to report the prompt to its supervisor. It refuses (exit 4) when no
prompt is visible or when `<n>` is not an offered option, pressing nothing.
Unknown flags are usage errors (exit 2).

`--answer <n>` presses the digit first (Claude Code's numbered menus select on
the digit alone). After every press it re-reads the pane and checks the `❯`
cursor: if the prompt is gone, it is answered; if the cursor sits on row `<n>`,
Enter follows; if the cursor has not moved, it walks with Up/Down presses
computed from the current row to `<n>`, re-reading after each one, and presses
Enter only once the re-read shows row `<n>` selected. The moment the cursor is
anywhere the arithmetic did not predict (wrong direction, no move, a jump, or
the prompt vanished early), it presses nothing further, exits 5 with a message
naming the expected and observed rows, and pages the Regent through the
blocked-agent paging path with "take over: press the keys by hand".

`--dismiss` presses Escape once and verifies the prompt is gone the same way.
`--dry-run` prints the prompt and the keys it would press. Every answer,
dismissal or take-over is appended to `~/.throne/data/regent/mcq-answers.jsonl`
with the agent, pane, question, command, chosen option, caller and time. Keys
go through `herdr pane send-keys` with the names `up`, `down`, `enter`, `esc`.

## notify-lord

```bash
./bin/throne-cli notify-lord <message...>
```

Sends one deliberate message to the Lord through the throne's configured
**tailnet-only ntfy transport**. The command joins all message arguments with a
single space and trims the result. An absent, empty, or whitespace-only message
is rejected before any network call with:

```text
notify-lord: message required. Usage: ./bin/throne-cli notify-lord <message...>
```

A valid message is passed to `postNtfyMessage` exactly once and awaited. The POST
uses the explicit ntfy title `Message from the throne`; automatic completion
pushes keep their separate `Throne campaign completed` title. Success prints:

```text
notify-lord: message delivered to the Lord.
```

A transport failure exits non-zero and prints
`notify-lord: failed to notify the Lord (<error>)`. The command does not retry,
so one invocation cannot silently duplicate a delivery.

The command reuses `NOTIFY_CONFIG` from `src/notify-lord/notification.service.ts`: the
server URL and topic from the gitignored `config.user.ts` `ntfy` section (the
committed fallback is the inert `http://127.0.0.1:8410`, topic
`throne-notifications`), and a 5-second request timeout. Set
`THRONE_NTFY_SERVER_URL` or `THRONE_NTFY_TOPIC` before starting the process to
override the first two;
configuration is captured once per process. `THRONE_NOTIFY_SHADOWS` affects
only automatic Shadow-completion pushes and does not gate explicit messages.

Invoking `notify-lord` is an intentional external side effect. Use it for a
message that should reach the Lord's phone, not as a hidden progress-log channel
or as a substitute for `send-agent` within the court.

## create-agent

Fresh campaign Alpha and Shadow launches must pass `--cwd` inside the matching
throne-managed external Git worktree before registration or launch. The live
throne or target checkout, a missing tree, and a mismatched managed tree are
hard refusals. `--empty-worktree` explicitly creates/uses
`~/.throne/worktrees/empty/<agent-name>` with generated `AGENTS.md`; it is
persisted as empty-workspace provenance and cannot act as Git delivery
authority. There is no treeless bypass.

**Herdr operator skill (Stager and Regent only).** Before launch, a Stager
spawn writes `<cwd>/.claude/skills/herdr/SKILL.md`, generated from the pinned
client's own `herdr --skill` with the court's rules prepended (reads and
`tab focus` are free; anything that types into a pane goes through
`send-agent`; agent lifecycle stays with `create-agent`/`reap-agent`).
`resurrectRegent` does the same into the throne root. Alpha and Shadow never
receive it; the file is gitignored and re-rendered on every spawn so it can
never drift from the pinned client. `bin/herdr` is a shim on every tab's PATH
that resolves to that pinned client (`THRONE_HERDR_CLIENT_PATH`, then the
highest `~/.local/share/throne/herdr/v*/herdr`, then PATH). Generator:
`src/herdr/herdr-operator-skill.ts`; a failed render is reported on stderr
and never fails the spawn.

**Forking a Stager on a topic change (`--topic-from <origin>`).** The
`/throne-fork` skill is the authority on when and how to drive this flag;
this passage stays the authority on the flag's own behavior. `create-agent
--topic-from stager-oak --role Stager --supervisor Regent --name
stager-prmedia` spawns a FRESH Stager to take a prompt whose topic changed in
`stager-oak`. It never reuses an idle Stager. `--topic-from` takes the
origin's full registered name; there is no `--fork-of` alias. It refuses,
registering and launching nothing, and names which condition failed, unless
all of these hold: the role is `Stager`; the supervisor is `Regent`; the
origin is live in the roster with ledger role `Stager`; the origin's latest
line in `topic-verdicts.jsonl` is a change; and the fork's brief is written.

The model is `--model` when given, otherwise the origin's live observed model
(the same reader `restart-harnesses` uses, `src/session/live-claude-model.ts`),
otherwise the origin's ledger model; one stderr line says which of the three
was used. The fork gets its own worktree like every other agent — pointing
`--cwd` at the origin's tree trips the existing borrowed-worktree refusal.

A forked pane inherits NO conversation, so the origin writes the brief to
`~/.throne/data/<fork-name>/brief.md` in the five-marker shape (INTENT, SCOPE,
RULINGS, VERIFIED-NOUNS), checks it with `throne lint-queue-plan --body-file`,
and `--topic-from` seeds it as the fork's opening prompt, together with
`lord-prompt.md`, the prompt that changed the topic, copied verbatim from the
origin's transcript. Anything settled in the origin's conversation and left out
of the brief is lost.

The spawn records `forked_from: "<origin>"` in `spawn.json` and a
`- **Forked from:** <origin>` line in `identity.md`. The identity names the
Regent as supervisor and says a fork holds full Stager powers that answer to
the Lord, never to the brief — filing a queue row needs the Lord's own word,
typed in the fork's own pane or copied into its `lord-prompt.md`, and a fork
forks again only when its own topic changes. A fork reports to no one: it leaves its pane showing the
result and stays alive until the Lord reaps it. The autoscale floor and Stager
reuse count it like any other Stager.


`--model pi/flash` and `--model pi/pro` launch a pi agent on the newest
DeepSeek flash or pro model (a bare `pi` means `pi/flash`); the launch output
names the id chosen and whether it came from DeepSeek's list, the day cache or
the pinned fallback. The launch is refused, launching nothing, when the
DeepSeek provider account is missing, its key file is missing or empty, or the
file is readable by anyone but its owner. `spawn.json` records the pi session
id, the model id and display name, and the account name; never the key.

## Run a custom harness to process exit

`create-agent --run-custom-harness-to-exit` is the custom-executable-only, non-resident path. It leaves no registered, watchable agent in herdr, so it is gated on the Lord's explicit authorization: every invocation must also pass `--bypass-run-custom-harness-to-exit`, and that flag is passed only when the Lord asked for a one-shot cell (Lord, 2026-09-08). Without it the command refuses before anything launches and tells the caller to spawn a resident agent instead. It uses the caller's exact `--harness-executable` and every token after the first standalone `--`; `--prompt` is refused because composer delivery remains resident-only. The mode requires `--clear-environment`, accepts unique `--env KEY=VALUE` entries without inheriting ambient variables and refuses duplicate keys, honors `--cwd`, uses the exact caller-supplied `--name` as its visible Herdr tab label, and closes that tab after real process exit. It writes stdout, stderr, numeric exit status (`124` on timeout), wall milliseconds, and scrubbed JSON launcher evidence with requested and filesystem-resolved executable paths to the five explicit path flags. `--timeout-ms` terminates the child process group. It creates no `~/.throne/data/<name>` registration, has no resume recipe, does not participate in worktree-stranding detection, and refuses an already-visible tab with the same label. Every one-shot-only flag is refused when the mode flag is absent, before policy or lifecycle effects. The `--model` is resolved through the canonical model registry, which supplies the harness; caller-supplied `--harness` is refused. Effort, plan admission, steering, quota, and their normal bypass flags are still evaluated as policy evidence; the custom executable replaces only configured launcher argv. Resident custom recipes remain registered, composer-prompted, startup-reconciled, and exactly resumable from `spawn.json`; legacy records without custom fields retain configured-launcher reconstruction.

Claude one-shot cell:

```bash
./bin/throne-cli create-agent --model fable --effort 1 --name example-claude-cell --supervisor alpha-example-one-shot --role Agent --cwd "$CELL_HOME/work" --non-campaign --bypass-preset-agent --harness-executable /absolute/path/to/claude --run-custom-harness-to-exit --bypass-run-custom-harness-to-exit --clear-environment --env "HOME=$CELL_HOME" --env PATH=/usr/local/bin:/usr/bin:/bin --env TERM=dumb --env "CLAUDE_CONFIG_DIR=$CELL_HOME/.claude" --stdout-path "$CELL_HOME/result.jsonl" --stderr-path "$CELL_HOME/result.stderr" --exit-status-path "$CELL_HOME/result.rc" --wall-time-path "$CELL_HOME/result.wallms" --launcher-evidence-path "$CELL_HOME/result.launcher.json" --timeout-ms 120000 -- -p "$PROMPT" --output-format stream-json --verbose
```

Codex one-shot cell:

```bash
./bin/throne-cli create-agent --model gpt-5.4 --effort 1 --name example-codex-cell --supervisor alpha-example-one-shot --role Agent --cwd "$CELL_HOME/work" --non-campaign --bypass-preset-agent --harness-executable /absolute/path/to/codex --run-custom-harness-to-exit --bypass-run-custom-harness-to-exit --clear-environment --env "HOME=$CELL_HOME" --env PATH=/usr/local/bin:/usr/bin:/bin --env TERM=dumb --env "CODEX_HOME=$CELL_HOME/.codex" --stdout-path "$CELL_HOME/result.jsonl" --stderr-path "$CELL_HOME/result.stderr" --exit-status-path "$CELL_HOME/result.rc" --wall-time-path "$CELL_HOME/result.wallms" --launcher-evidence-path "$CELL_HOME/result.launcher.json" --timeout-ms 120000 -- exec --json "$PROMPT"
```

```bash
./bin/throne-cli create-agent \
  --model <model> \
  [--effort <1-6>] \
  --name <unique-name> \
  --supervisor <name> \
  [--escalation <name>] \
  [--role <role>] \
  [--cwd <path>] \
  [--prompt <text>] \
  [--requires <ignored>] \
  [--bypass-model] \
  [--bypass-zero-quota] \
  [--bypass-opencode-telemetry-unavailable] \
  [--bypass-effort] \
  [--objective-code <code> | --non-campaign] \
  [--bypass-alpha-guardrail] \
  [--bypass-preset-agent] \
  [--harness-executable <absolute-path> [-- <complete harness argv…>]] \
  [--run-custom-harness-to-exit --bypass-run-custom-harness-to-exit …]
```

There is no `--bypass-harness` flag. `--harness` itself is refused outright for
fresh requests (`create-agent: --harness is no longer caller-selectable; infer
the harness from the canonical model registry by passing --model.`) — the
canonical model registry (`src/harness-routing/model-registry.ts`) derives the
harness from `--model`, so choosing a different harness means choosing a
different `--model`, never a bypass flag. The only escape from the
registry/role-pool machinery entirely is `--harness-executable` plus
`--run-custom-harness-to-exit`, a distinct one-shot custom-executable path
documented under "Run a custom harness to process exit" below — it is not a
routing bypass.

`--requires <value>` is accepted and ignored (since 2026-11-15, when model
grades were removed): `create-agent` prints one notice line saying
so and the spawn proceeds exactly as if the flag were absent. Role pools alone
decide which model may fill a role.

**Effort is steered, not chosen, on EVERY fresh pair.** `resolveFreshEffort`
(`src/harnessrouting/steering.ts`) resolves an omitted `--effort` by clamping the numeric
`ACTIVE_TARGET_EFFORT` from `src/config.ts` into that model's registered
`EFFORT_RANGES` band — for every harness and every model, not a two-pair
exception. Inspect `list-harnesses-and-models` for each model's current ordinary
resolved effort; do not copy the current target into documentation.
Explicit `--effort`
at that ordinary score is equally ordinary; every other explicit score is
REFUSED with a steering message naming the ordinary score and `--bypass-effort`,
which forces the requested score for that one spawn and is recorded as durable
policy-override evidence. That flag clears only the effort steer: it never
bypasses active-plan membership,
usage/quota, harness/model validation, objective, role/preset, trust,
registration, or lifecycle checks. Exact registered dead resumes keep their
stored effort without a new `--bypass-effort`; conflicting explicit resume
flags still refuse.

### Objective contract

Objective flags govern only new `Alpha` and `Shadow` campaign roles. A new
campaign Alpha supplies one ASCII-alphanumeric token with
`--objective-code <code>`. The token is canonicalized to lowercase, the stored
handle must be `alpha-<code>-...`, and `create-agent` records
`objective_code: <code>` in `~/.throne/data/<name>/spawn.json` plus
`Campaign objective code: <code>` in `identity.md`. `--objective-code` and
`--non-campaign` are mutually exclusive.

A new campaign Shadow never receives `--objective-code`. It inherits the
supervising Alpha's recorded contract and must use the canonical
`shadow-<code>-...` handle. The read-only derivation command is the single
operator seam for that handle:

```bash
./bin/throne-cli derive-shadow-name-from-alpha <supervising-alpha-name> <slice-id>
```

The command reads the Alpha's `spawn.json` evidence and prints the complete
handle. It refuses contradictory fields, invalid or mismatched recorded codes,
and missing or unreadable evidence. A pre-contract Alpha with readable spawn
evidence that has neither `objective_code` nor `non_campaign` gets only the
narrow compatibility fallback of the first canonical token after `alpha-`.
Unreadable evidence never enters that fallback. The `/execute-todos` throne
recipe uses the exact printed handle for the Shadow tree, `--name`, ledger,
`send-agent`, `agent-logs`, merge, and reap commands; it must never hand-copy an
objective code or pass one independently to a Shadow.

Deliberate Alpha or Shadow infrastructure outside a campaign must opt out with
`--non-campaign`. The flag records `non_campaign: true` in `spawn.json` and
`Campaign status: non-campaign` in `identity.md`. A Shadow under a
non-campaign Alpha must opt out explicitly as well; the exemption is not
inherited as an implicit campaign. The Regent is not registered through
`create-agent` and is exempt, while ad-hoc roles remain outside this contract
only when their explicit role admission uses `--bypass-preset-agent`.

| New or resumed target                       | Objective contract                                                         | Durable evidence and name behavior                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Campaign Alpha                              | `--objective-code <code>`                                                  | Lowercase code in `alpha-<code>-...`, identity, and `spawn.json`.                           |
| Campaign Shadow                             | No objective flag; inherit from the supervising Alpha                      | Live derivation returns `shadow-<code>-<slice-id>`; use that exact handle.                  |
| Non-campaign Alpha or Shadow infrastructure | `--non-campaign`                                                           | `non_campaign: true`; no objective code is recorded or required.                            |
| Registered resume                           | Flags are optional; any supplied objective flag must match stored evidence | Stored name, recipe, identity, and evidence remain exact; no retroactive policy is applied. |

Native Claude models launch through `claudey`. Native Codex agent creation is
disabled: every fresh GPT/Codex outcome is finalized as `codexy-all-omni`, even
when steering selects a `codex`-harness model; no fresh `codexy` process is
permitted. There is no `--bypass-harness` flag to temporarily select `codex`
instead — the harness is a pure function of the resolved `--model`. Inspect
`./bin/throne-cli list-harnesses-and-models` for the live selected harness and
launcher. Explicit configured non-native alternates remain available where
policy admits them, chosen via `--model`. Unknown slugs are refused before
spawning. opencode is a first-class registry harness: fresh models whose
canonical entry uses `opencode` are admitted by the normal routing and role pools and launch through the
throne-owned `opencodey` launcher (see `launchers.md`).

`claudey-all-omni` is a separate, experimental standalone launcher, not a
`create-agent` route and not a `switch-agent-model` launcher family. It admits
only `codex/gpt-5.6-sol`, points Claude Code at loopback OmniRoute on port
20128, reads the dedicated mode-`0600` OmniRoute ingress key, and pins all
background/default model selectors to that same provider-qualified model. No
Claude-family identity is admitted: the available candidate lacked successful
end-to-end generation and tool-use proof through CLIProxyAPI, so the route
refuses every `claude/...` spelling rather than relabeling GPT output. Its
OmniRoute policy and provider-row lifecycle is managed by
`provision-claudey-all-omni install|validate|remove`; see `omniroute/README.md`
for prerequisites, exact policy, rollback, and the live proof deferred to the
99b deployment slice. Canonical `claudey-all` remains the direct port-8317
CLIProxyAPI launcher used by stored legacy GPT-on-Claude resumes, so this
experiment changes neither fresh spawn routing nor model-switch behavior.

Fresh GPT registrations follow the configured forward policy by default. An
explicit non-native alternate is admitted by naming it directly with
`--model`, never by a `--bypass-harness` flag — no such flag exists; native
`codex` is never an alternate and is finalized to `codexy-all-omni`.

Spawns a new herdr harness under a unique `--name`. The caller supplies only a
model identity; the canonical model registry supplies its harness and aliases.
Caller-selected `--harness` is refused for fresh requests. The spawn lifecycle is
**registration-before-launch**: guards validate inputs, then `~/.throne/data/<name>/`
(identity + spawn spec) is written _before_ the harness is started, so any
post-spawn failure leaves either no artifacts or a registered agent — never a
live pane without a record.

**Re-run semantics:** when `create-agent` is invoked with the same `--name`
against a registered-but-not-launched agent (e.g., after a prior crash):

- If a **live agent** exists under that name, refuse before any quota read or
  second-pane side effect.
- If the agent is **registered but not running**, conflict-check the supplied
  model/effort/cwd against `spawn.json`, then relaunch the stored recipe
  exactly, marked "Resumed" not "Spawned". The resume skips current active-plan
  membership, usage routing/remapping, final pool
  defense, and identity/opening-record/spec writes. A stored native `claude/fable` or
  `claude/opus` pair still passes through the common final native quota gate;
  every other stored pair reads no Claude quota for that gate. "Resumed" means
  a fresh harness process built from the stored recipe, not native-session
  continuation. A refused native resume retains byte-identical identity and
  spawn ledgers. A historical stored native `codex` recipe instead refuses
  before trust, writes, tab creation, or launcher execution. Its durable files
  remain byte-identical; migration is explicit reap followed by a fresh
  `codexy-all-omni` registration.

The launch argv is derived by `harness.ts`'s `buildLaunchArgv`: native Claude
runs `<throne>/bin/claudey --model <model> --effort <token>`; fresh Codex-family
agents run `codexy-all-omni`; opencode runs `<throne>/bin/opencodey -m <model>`
with no effort token (its registered effort band is the fixed ordinary 1–1; an
exact registered opencode resume appends `-s <id>`); and an exact
stored legacy Claude/GPT resume reconstructs `claudey-all --model <model>
--effort <token>`, the one launcher still resolved from `PATH`.
The portable `--effort` score (1–6) maps a launch token: claude
`low|medium|high|xhigh|max|ultracode`, codex `low|medium|high|xhigh|max|ultra`
(effort 6 = the harness's max tier); opencode emits no effort token at all.
The command writes `~/.throne/data/<name>/identity.md`
with the agent's role and two addresses — `--supervisor` (routine contact, the
creator) and `--escalation` (blocker contact, defaults to the Regent) — and
writes the complete composed launch instructions byte-for-byte to
`~/.throne/data/<name>/opening-prompt.md`. A disabled-default Alpha admitted through
`--bypass-alpha-guardrail` gets the exact target-named `Policy override for
<name>:` statement in both durable records. This one-spawn evidence names the
requested `(harness, model)` and survives registered relaunches; ordinary
identities remain byte-identical when no override exists.
`--role` defaults to `Agent` — but the default is no longer silently spawnable:
a non-preset role (including the bare `Agent` default) is refused without
`--bypass-preset-agent` (see below).

The complete opening instructions are built from up to three parts and persisted
before launch in `~/.throne/data/<name>/opening-prompt.md`. They never ride the launch argv:
the harness starts with only its launcher and short model/effort flags. Native
Claude and resident custom harnesses receive that complete body through
`deliverOpeningPrompt`, exactly once and byte-for-byte. Native Codex instead
receives one compact, completely observable bootstrap that gives the exact
absolute paths of both `opening-prompt.md` and authoritative `identity.md` and
orders the harness to read them before acting. The durable opening record retains
every byte of a long or multiline `--prompt`; the compact transport never treats
a clipped prefix as proof. Ordinary `send-agent` transport is unchanged. A spawn
is reported successful only once its selected submission is proven; a delivery
that fails before any text was written is retry-safe, and one that fails after
delivery began is indeterminate and is never automatically resent. The three
complete-record parts are:

- the **identity sentence** (chain of command), always first;
- for `--role Alpha`, a **standing instruction** to execute the objective by
  running `/write-and-execute-todos` — inside the throne, running it means the
  Alpha itself spawns a real Shadow per slice (via `create-agent --role
Shadow`); the Regent never spawns an Alpha's Shadows. DONE and blocker
  `send-agent` messages wake the Alpha immediately; no dependency-ready work
  makes it idle with no scheduled sleep, query, or model turn. `agent-logs` is
  limited to one completion review, an explicit blocker, or silence beyond the
  30-minute Regent heartbeat interval, and `agent-statuses` is not a polling
  substitute. Generated Alpha text containing a shell loop that combines sleep
  with either query command is refused before registration or launch. A non-Alpha
  role gets no such instruction;
- `--prompt <text>`, an optional **objective brief** appended after the identity
  block.

A registered native Codex recipe is historical migration evidence, not runnable
compatibility state; relaunch refuses without rewriting its durable records.

`--role Shadow` applies the `shadow-` role prefix idempotently, but campaign
work must use the complete objective-coded handle returned by
`derive-shadow-name-from-alpha`. That returned name is the single addressable
handle used everywhere: `~/.throne/data/<name>/`, identity, spawn spec,
`send-agent <name>`, `agent-logs <name>`, and the herdr tab label. The
`/execute-todos` Shadow-spawn path obtains this value from the supervising
Alpha's durable evidence rather than constructing `shadow-<slice-id>` itself.

Inside the throne this is how a per-slice **Shadow** is born: `/execute-todos`
(when it detects throne context) first runs
`derive-shadow-name-from-alpha <the Alpha> <slice-id>`, then pairs the exact
returned handle with `spawn-git-tree <handle>` and `create-agent --role Shadow
--name <handle> --supervisor <the Alpha> --escalation Regent --cwd <slice tree>`.
It delivers the slice's assignment through a file the Shadow reads, then uses
the same handle for monitoring, merge, and reap. Large multi-section briefs
remain file-based, and the one-line `send-agent` pointer keeps bulk content out
of pane transport. See agent_docs/role-alpha.md → "Shadows are real harnesses in the throne"
and the `execute-todos` skill's Rule 2 "Throne context" paragraph.

Four boolean flags implement the spawn policy. Two are uniform steer bypasses — `--bypass-model` and `--bypass-effort`, each disabling exactly its own steer and nothing else; usage steering is mandatory (see "Spawn steering" below).
There is no `--bypass-harness` flag; an alternate fresh-GPT harness route is
chosen by naming it directly with `--model`, described above. The
remaining two gate a role rather than a steer. **`create-agent`
spawns only
the preset roles `{Alpha, Shadow}`** without `--bypass-preset-agent`; every
other role (the generic `Agent` default, `none`, canaries, probes) is refused
(exit 1, nothing spawned or written) unless the flag is passed. The gate keys
ONLY on the spawned role, never the caller's identity — anyone may spawn an
Alpha or a Shadow. A separate cross-role-prefix guard refuses a name carrying
a foreign role's prefix, so the `agent-shadow-02` double-prefix can no longer
occur.

`src/config.ts` is the single declarative source for active-plan membership.
New spawns are classified as `Alpha`, ordinary `Shadow`, or `ShadowSlice99`
(the last by the final `shadow-99…` name), then their exact requested
`(harness, model)` must belong to the live role pool before
usage policy runs. Inspect `./bin/throne-cli list-harnesses-and-models` for
the active preset and its current ordered pools. The active pool is the OUTER
boundary only, admitting every pair a steer or a `--bypass-model` may land on,
so no steer target is walled off by the preset. Which admitted row a given
spawn actually gets is decided by the steers below.

Every routing, validation-model selection, and equivalent-tier remap candidate
is constrained to that same immutable pool, and the exact resolved final pair
is checked again before launch. An excluded explicit
pair refuses clearly and is never silently substituted. There is no active-plan
bypass: `--bypass-preset-agent` only admits a non-preset ad-hoc role; that role
has no `PlanRole` and skips pool membership, while all later gates — including
the final native quota gate — still apply.

### Spawn steering

All model, usage, and effort steering for a fresh spawn is ONE call into the
steering engine: `steerSpawn` (`src/harnessrouting/steering.ts`). `create-agent` parses
the flags, fetches usage, resolves the supervising Alpha's pair, invokes the
engine once, then applies the result — it holds no steer logic of its own, and
`src/config.ts` holds the steer data with no logic. The engine returns either a
launch (pair + effort + a note recorded on the `Spawned …` line) or a refusal
whose message names the steer, the compliant spawn, and the exact bypass flag.
Usage readings are fetched only while a steer that would consume them is
unbypassed; omitted or unreadable usage never blocks a spawn.

**Model steer.** The model registry in `src/harnessrouting/` owns the
current allowed set; inspect `list-harnesses-and-models` before spawning. A
divergent request is refused toward that set unless `--bypass-model`. Within the
set, usage balance prefers the higher projected remaining at reset, comparing
the fable-scoped weekly forecast against the aggregate weekly forecast and
falling back to current remaining only when evidence is insufficient. An exact
tie and an unreadable window both leave the balance inert with a recorded note.
Once Claude aggregate projected remaining at reset (or current remaining when
forecast evidence is insufficient) is at or below the configured
the configured desperation threshold, usage steering selects the strongest
usable candidate at ordinary effort; usage steering is mandatory. When a
telemetry source is unusable the fallback is recorded rather than waiting.

**`99` gate steer.** The gate steer is
keyed by the supervising Alpha's harness, so the gate never grades work in the
voice that produced it. Inspect `list-harnesses-and-models` for the live
eligible validator scores from `list-harnesses-and-models`
for code-level provenance. The Alpha's pair is
read from the supervisor's durable `~/.throne/data/<supervisor>/spawn.json`; an
undeterminable supervisor leaves the steer inert with a loud recorded note
(fail-open, but speaking). While the target IS usable, a divergent request is
refused unless `--bypass-model`. The metric-selected route is best-case: when
its authoritative aggregate or session quota is zero or otherwise unusable, the
engine SUBSTITUTES the strongest actually usable in-pool pair, preferring the
Alpha's equivalent candidate when it is available. Durable
routing evidence names the ideal, its unusable state, and the fallback. The
substitution never lands outside the pool; if no usable in-pool pair exists,
the hard gates refuse.

**Execution-shadow metric steer (`01`–`98`).** The active role pool owns the
`list-harnesses-and-models`; usage metrics select among its rows.
Everything else is usage-balanced across companies over the reserve-filtered
pool. `create-agent` reads both harnesses' live plan usage through the shared
Nest-owned usage adapter and cache-backed `getUsagePayload` pipeline (see
`plan-usage-remaining` below), so a burst of
spawns reuses a recent reading and rides through a transient endpoint blip
instead of hammering the endpoint or failing. It first filters both harnesses to
the active role pool; excluded telemetry cannot influence signal health,
exhaustion, or selection. Among admitted usable harnesses, Claude is selected
only when its projected remaining at reset leads Codex's by at least the
inclusive `CLAUDE_PROJECTION_LEAD_THRESHOLD_PCT` in `harnessrouting/usage.ts`, with
current remaining as the explicit basis when sufficient forecasts do not
exist; every smaller lead conserves the scarcer Claude pool and routes to
Codex. The recorded route reason names the basis, both values, the computed
lead, and the threshold. Claude is excluded when its 5-hour
remaining reaches the runtime `SESSION_FLOOR_PCT` only when an admitted fallback
exists. Inspect `list-harnesses-and-models` for the current threshold. On a
route to the other admitted harness the requested model is remapped to the equivalent
`MODEL_POLICY` coding tier — so an explicit in-set pair is **not** exact by
itself: the tier is preserved, the harness may be remapped with a recorded
reason, and no flag pins the requested pair against usage steering.

**Effort steer.** Applied last, on the pair the model steer resolved, exactly as
described under the effort contract above: omitted `--effort` takes the active
preset's ordinary score for that model's range, a divergent explicit score
refuses naming `--bypass-effort`.

**Bypasses are one-to-one.** `--bypass-model` disables only model steering; `--bypass-effort` disables only the effort steer. Usage steering, bounded-history forecasting, and history reads are mandatory. There is no `--bypass-harness` flag; an explicit fresh GPT harness request is made by naming it directly with `--model` — defaults still follow the configured forward GPT policy and exact stored resumes remain exact.

For the explicitly requested OpenCode DeepSeek route,
`--bypass-opencode-telemetry-unavailable` disables only the unusable-telemetry
refusal. Fresh, complete, positive telemetry needs no such flag. Trustworthy
exact-zero telemetry remains refused unless `--bypass-zero-quota` is supplied;
neither bypass implies the other. This admission path is the legacy deepseek
canary, retained for stored `codexy-all-omni` recipes; fresh DeepSeek spawns
use the first-class registry model route instead.

**Final native quota gate:** once the exact final pair is known, both new spawns
and dead registered resumes targeting `claude/fable` or `claude/opus` evaluate
that exact model through `src/create-agent/native-availability.ts`. Fresh authoritative
`exhausted` evidence hard-refuses and names the native model, exhausted window,
remaining percentage, and reset time. Usage steering cannot clear that refusal. `unknown` and `source-failure` warn exactly once and
proceed because stale, malformed, missing, or failed telemetry is not proof of
exhaustion. The `5h` window applies to both models; a matching model-scoped
weekly window overrides aggregate weekly for that model. If routing and the
final gate both need Claude telemetry, one memoized promise supplies both.
This gate finishes before Codex trust, registration writes, `afterRegistration`,
tab creation, or harness execution; a refused new spawn leaves no registration
or launch effects, and a refused resume leaves its existing ledgers untouched.

The hermetic acceptance canary
`test/create-agent-native-quota.canary.test.ts` executes the actual
`throne/bin/throne-cli create-agent …` path with a scratch `HOME`, synthetic
Claude OAuth credentials, a fetch preload owning the usage endpoint, a fake
first-in-`PATH` `herdr`, and fake native launchers reached through
`THRONE_LAUNCHER_DIR`. Fresh exhausted-Fable telemetry must
produce a nonzero refusal with reset evidence, no registration, no herdr
mutation, no harness execution, and no un-intercepted network; `finally`
cleanup removes all canary artifacts even when an assertion fails.

**Spawn tasking confirmation.** Enqueuing the opening prompt is not proof it
was ever consumed — `deliverAgentOpeningPrompt`
(`src/create-agent/opening-prompt.ts`) additionally confirms, for a genuine
resident launch that carried a caller-supplied `--prompt` on the Claude
harness, that the spawned agent's own transcript actually shows assistant
activity before `create-agent` reports success. Confirmation calls
`awaitSpawnTaskingConfirmation` (`src/session/runtime-model-acceptance.ts`),
a bounded poll — every 3 seconds (`SPAWN_TASKING_POLL_INTERVAL_MS`), up to a
90-second deadline (`SPAWN_TASKING_BOOT_GRACE_DEADLINE_MS`) — around the same
transcript-attestation primitive (`checkAgentRuntimeModelAcceptance`) the
opening prompt's delivery result is derived from. This is additive: the
existing `Spawned "<name>" ...`/`Resumed "<name>" ...` line and the exit code
for a launch that genuinely succeeded are unchanged, and every non-Claude or
non-resident-launch spawn skips confirmation entirely.

The confirmed result prints as a second stdout line, `Spawn tasking:
<outcome>.`, where `<outcome>` is one of four `SpawnTaskingOutcome` values
(`src/create-agent/create.types.ts`), derived by
`deriveSpawnTaskingOutcome`:

- `tasked` — the enqueue succeeded and the transcript confirmed assistant
  activity following the requested model before the deadline.
- `enqueued-unconfirmed` — the enqueue succeeded but the bounded wait expired
  with no confirming transcript evidence; this is the exact shape of a
  swallowed opening prompt and the outcome an operator should treat as
  "assume untasked, go verify."
- `quarantined-not-tasked` — the enqueue succeeded but the transcript shows a
  different model than requested.
- `not-applicable` — confirmation was never attempted: a non-Claude harness,
  a resume that left the harness already live, or no genuine caller-supplied
  `--prompt` to confirm.

**Delivery receipt check.** Delivery is one `herdr pane send-text`, but the pty
hands the text to Claude Code in roughly 1 KiB reads, so a long text lands in
the composer as several `[Pasted text #N]` placeholders plus a literal tail. On
2026-09-16 one Stager's Claude dropped both placeholders at submit and its
first turn was the last 235 of 2275 characters. The loss happens inside the
harness and leaves no screen signal, so the court checks the recipient's
transcript after delivery. `create-agent` itself does not wait on that check
and never pastes a prompt a second time: an opening prompt delivered through
the queue is an ordinary delivered message and is checked like every other.

When `deliverMessageWorkItem` (`src/throne-work/message-delivery-handler.ts`)
marks a `message-delivery` row `delivered`, it schedules one
`delivery-receipt-check` work item
(`src/delivery-receipt/delivery-receipt-check.ts`) due 10 seconds later. The
item carries the message id, the delivered time, and the exact text that was
typed into the pane: the attributed payload, or the pointer line when the
message went file-backed. A failure to schedule is written to stderr and never
changes the delivered message. A message that failed delivery, a direct send,
and a delivery notice get no check.

The check is dispatched through the plain work-kind handler table, outside the
recipient's pane lock. It finds the recipient's Claude transcript from its
spawn record (`readSpawnSpec`, then `claudeTranscriptPathFor`) and judges it
with `deliveryReceiptVerdict`:

- `intact` — the check ends.
- `truncated` — the recipient is sent the one cut-short notice.
- `absent` — the check looks again 60 seconds later. Once 15 minutes have
  passed since delivery and the recipient is idle (`idle` or `done` in the
  status `agent-statuses` prints), it is sent the one may-not-have-reached-you
  notice. A busy recipient, or one not among the live agents, is not notified;
  60 minutes after delivery the check ends as `unobserved` and sends nothing.

A recipient that is not a Claude-branch harness, has no spawn record, or has
no transcript ends the check as `unobserved` with nothing sent, and so does a
message whose own row was already swept. Every check row ends `delivered` with
its result in the payload's `outcome` field: `intact`, `truncated`,
`absent-notified`, or `unobserved`. A notice is enqueued through
`enqueueDeliveryNotice`, which refuses a second notice for the same message id
in any state, and a notice is typed without the `[message <id>]` suffix so its
last characters are the `read-message` command.

One limit: when a spawn record holds no session id, the transcript read is the
newest one in the recipient's Claude project folder, so a second Claude
session started in the same working directory can be the one that is read.

Confirmation evidence is written the same way `checkAgentRuntimeModelAcceptance`
already persists it for every phase, under
`~/.throne/data/<name>/runtime-model-evidence/spawn-<attestation|quarantine>.json`
(`attestation` for a matching model, `quarantine` for anything else) — the
`spawn-` phase prefix keeps it distinct from the files `send-agent`'s own
runtime-model gate writes for its own phases.

### The runtime-model gate and who it quarantines

`send-agent` (phase `task`) and the reap preconditions (`src/slice-evidence/
agent-evidence-gate.ts`) both call `checkAgentRuntimeModelAcceptance`
(`src/session/runtime-model-acceptance.ts`). It compares the recipient's
recorded `spawn.json` model against EVERY assistant record in the pane's
Claude transcript; one record on another model is a `mismatch`, and the pane
stays mismatched for its whole life even after switching back.

- **Reap and complete report a mismatch and never refuse on it (Lord,
  2026-09-23: "Reaping shouldn't rely on the mismatch").** `reap-agent` and
  `complete-agent` still run the `verdict` attestation and keep
  `verdict-quarantine.json` as evidence, print one stderr warning
  (`warning: "<name>" ran on claude-opus-5-5, spawn.json says opus; recorded
  at <path>`), and proceed. The reapability JSON claim is the only claim-side
  check. Only delivery proven from git
  and a clean own worktree can refuse them.
- **Campaign roles (Alpha, Shadow, Agent) are quarantined on mismatch at
  `send-agent`.** The send is refused with exit 1 and nothing is queued; evidence lands at
  `~/.throne/data/<name>/runtime-model-evidence/<phase>-quarantine.json`.
  There is no bypass flag and none should be added — a campaign pane on the
  wrong model is a defect, and it happens more often than it looks.
- **Stager and Regent are exempt (Lord, 2026-09-07).** They are human-steered:
  the Lord switches them between opus and fable by hand and on purpose. The
  gate resolves the role from `identity.md` (and the literal name `regent`,
  which carries no `spawn.json`), returns `exempt-human-steered-role`, and
  still writes the attestation as `<phase>-exempt.json` so a mis-spawned pane
  remains visible. `send-agent` prints one stderr line when the pane was
  observed off its recorded model — `"<name>" is a Stager observed on … —
  human-steered role, delivering anyway` — and delivers.
- **For the Regent:** an exempt notice is information, not a blocker. Do not
  quarantine, do not respawn, do not report it to the Lord as a delivery
  failure. The message went through.

## switch-agent-model

```bash
./bin/throne-cli switch-agent-model <agent> --model <target> [--effort <1-6>] [--confirm] [--bypass-model] [--bypass-effort] [--bypass-alpha-guardrail] [--bypass-zero-quota]
```

Registered Alpha and Shadow switches reapply the applicable active model pool,
steering, effort, stored-objective, native Codex,
and exact-zero quota restrictions before closing the old harness.
`--bypass-model` disables only model steering, `--bypass-effort` disables only
effort steering, and `--bypass-zero-quota` disables only exact-zero quota
refusal. Hard pool membership, stored
objective evidence, recognized role identity, native-Codex refusal, transaction
safety, and launcher-family preservation remain enforced under every bypass.

Changes the model of one registered, live Claude or Codex agent by closing its
current tab and exact-resuming the same native session under a different model.
The registered name, cwd, chain of command, transcript, identity bytes, optional
tree evidence, and launcher family are preserved. The command does not send a
slash command into the agent and does not write provider defaults such as
`~/.claude/settings.json` or `~/.codex/config.toml`.

Only same-launcher-family moves are supported:

- native Codex models may switch only to another `codexy` model;
- native Claude models may switch only to another `claudey` model;
- legacy GPT-on-Claude models may switch only to another `claudey-all` model.

A native Claude model cannot cross to GPT-on-Claude even though both recipes
record `harness: "claude"`; their launchers and provider sessions differ.
Cross-harness and cross-launcher switching is refused before the current tab is
closed.

Without `--confirm`, the command prints the exact current and proposed recipes,
exits nonzero, and reports `outcome: refused-before-close; spawn.json changed:
no`. Rerun the reviewed command with `--confirm` to execute it. The target uses
the stored effort unless `--effort` is supplied. Either value must be an integer
from 1 through 6 and must fall within the configured range for the target model;
an unsupported effort or model is a pre-close refusal.

The switch is available only when the command can prove all of these conditions
from the live pane and durable registration:

- the name resolves uniquely to the exact registered pane and cwd;
- the agent status is `idle` or `done`, not `working`, `blocked`, or `unknown`;
- the active supported composer is empty and no external editor or modal owns
  the pane;
- `spawn.json` is readable, names a standard supported recipe, and has no custom
  harness executable or passthrough argv;
- the live `/status` result exposes the current model, cwd, and native session;
- a Codex session prefix resolves uniquely against `~/.codex/sessions`, and any
  stored full `session_id` agrees with the live session.

A resident draft is never discarded. A busy/active agent, nonempty composer,
custom recipe, unsupported harness, cwd or pane drift, ambiguous session, or
missing evidence refuses before close where ownership is still certain. Wait for
the agent to settle or preserve/submit the draft through its normal owner; do
not clear a composer merely to force a switch.

After the replacement start is accepted, verification tolerates only startup
frames whose active composer is unavailable or whose screen cannot yet be
parsed. It makes 61 read-only observations at 250 ms spacing, spanning exactly
15 seconds between the first and last observation, while continuously holding
the replacement-pane lock. It never types, clears, submits, presses a key, or
closes a pane during that window. A confirmed nonempty composer, identity or cwd
drift, status rejection, or unsupported harness stops immediately without a
readiness retry. Exhaustion is indeterminate, preserves the replacement pane,
and leaves `spawn.json` unchanged.

On a confirmed switch, phase lines describe the transaction. Target and restored
recipe verification require the same native session, model, cwd, and compatible
effort. Effort is proved from `/status` when the harness exposes it; otherwise
the exact resume launch argv is the bounded evidence. Only after target
verification does the command update and read back `spawn.json`, recording the
new `model`, `effort`, full `session_id`, `switched_at`, and
`switched_from_model`.

The final status line is the operator verdict:

- `outcome: switched; spawn.json changed: yes` means the target exact-resume and
  durable update were both verified.
- `outcome: refused-before-close; spawn.json changed: no` means no tab was
  intentionally closed and retry is safe after correcting the stated refusal.
- `outcome: target-failed/rollback-restored; spawn.json changed: no` means the
  target failed, the previous exact session/recipe was verified running again,
  and durable spawn evidence stayed on the previous recipe.
- `outcome: target-failed/rollback-failed; spawn.json changed: no` means the
  target failed and the previous recipe could not be verified after rollback;
  inspect the named agent and phase log before taking any further action.
- `outcome: indeterminate` means pane ownership, launch state, preserved bytes,
  or durable evidence could not be proved. The accompanying `spawn.json changed:
no|yes|unknown` is the measured durable state, not permission to rerun blindly.
  Inspect `agent-statuses`, `agent-logs <name> --source visible`, and the printed
  phases before recovery.

Startup reconciliation remains backward compatible. A registration with a valid
full `session_id` exact-resumes that native session after a crash or reboot and
uses the transcript-aware recovery prompt. A legacy registration without one
still follows the established fresh-process recovery path from its normalized
stored recipe and work ledger. A successful model switch adds durable session
evidence for subsequent exact startup recovery; this command does not rewrite
legacy records merely by inspecting them.

The real provider/Herdr canaries are opt-in and are never part of ordinary CI:

```bash
THRONE_LIVE_SWITCH_AGENT_MODEL=1 bun test test/switch-agent-model-live.test.ts
```

That command runs native Codex Sol → Terra → Sol, native Claude Sonnet → Opus →
Sonnet, and GPT-on-Claude Sol → Terra → Sol. Each route uses a unique name of at
most 32 characters, a scratch git repository under `~/tmp`, the live
`~/.throne/data` ledger, and finally cleanup that reaps
the tab/registration, removes scratch and archived canary evidence, verifies an
uncommitted marker file survived, and fails if the relevant global provider config
was not byte-identical. Missing launchers, provider state, session evidence,
quota, network, or any cleanup proof is a canary failure; without the opt-in
environment variable all three routes are explicitly skipped.

## reap-agent

```bash
./bin/throne-cli reap-agent <name> --reason <enum> [--force] [--bypass-marker] [--spawn-process-gone]
./bin/throne-cli reap-agent <name> --reason abandoned --archive-abandoned-unmerged [--force] [--bypass-marker]
```

Tears an agent down entirely through the tooling — the teardown counterpart to
`create-agent` + `spawn-git-tree`, so reaping is never again scattered raw
`herdr pane close` + `rm -rf`. After all refusal-grade checks pass, it closes
the agent's herdr **tab** (via `closeAgentTab` — falling back to its pane),
removes the git **worktree** from the recorded target repo, safely deletes the
exact merged dedicated **branch** for ordinary reaps, and **archives**
`~/.throne/data/<name>/`. The distinct abandoned-unmerged disposition retains its exact
local branch instead; its full contract is below. The worktree is found by
branch rather than a reconstructed path and removed through `git worktree
remove --force` + `prune`; ordinary branch deletion is permitted only through
the separate safety gate below. A reaped agent drops out of `agent-statuses`
entirely.

- **A starting spawn is refused.** Before anything else, `reap-agent` reads
  the target's `spawn.json`. An agent whose spawn is still starting — its
  `create-agent` run has not recorded `spawn_finished_at`, no opening prompt
  is recorded in `tasked_at`, and it is younger than 300 s — is refused with
  its age and the bound, and nothing is torn down. `--force` does not override
  this. `--spawn-process-gone` does, and states that the agent's
  `create-agent` process is gone. The 300 s bound is the longest real
  spawn-to-prompt gap in the ledgers (about 210 s, over roughly 1,870 spawns)
  plus a margin; records whose `tasked_at` was stamped by a later
  `send-agent` after the agent was already working do not count. A starting
  spawn is also never redelivered as stranded, nor reported as untasked.
- **Live reapability claim required.** Before any live agent teardown,
  `reap-agent` reads the target's `state.json` and requires the state
  `reapable` with the reason `completed` (also accepting `abandoned` and
  `task_restart_required`), declared by `throne my-state reapable completed`.
  The agent's `{"reapable":"completed"}` marker line is for whoever reads the
  pane; the pane is never read. An absent or unreadable claim refuses and
  directs the caller to message the agent to distinguish reapable from merely
  idle. `--bypass-marker` alone overrides this precondition; `--force` does not.
  For a non-working live agent whose durable spawn record declares
  `deliverable_shape: "verdict-only"`, the latest canonical `completed` claim
  proves completion only when the supervising Alpha's delivery/completion stamp
  also exists through `hasDeliveryCommit`. A missing stamp refuses teardown;
  ordinary and working agents retain their existing content-proof refusal.

- **Explicit reason required.** Before archival, reap records `reaped_at` and
  `reap_reason`, then appends the complete lifecycle row to
  `data/stats/agent-timings.jsonl`. `--reason` accepts
  `completed|completed-unpublishable|stalled|force|orphan|superseded|error|abandoned|scratch|other`;
  `completed-unpublishable` records work that finished successfully but could
  not publish, and remains distinct from `abandoned` in timing, queue, and
  launch-ledger history;
  missing or invalid values are rejected before any teardown mutation.
  `--reason scratch` is for a disposable diagnostic probe that completed no
  real work (e.g. a send-agent canary target) — `agent-stats` excludes
  `scratch` rows from its completion/stall breakdowns entirely, so a
  throwaway probe never inflates or shrinks a harness's measured completion
  or stall rate. Use `scratch`, not `completed` or `other`, for that case.
  `--archive-abandoned-unmerged` is valid **only** with `--reason abandoned`;
  the mismatch refuses before teardown. `--reason abandoned` alone runs
  ordinary teardown.
- **Abandoned is final.** A reap never reopens a queue row: `--reason
  abandoned` (by hand)
  leaves a queue-linked row `abandoned`, and the autoscaler never launches an
  `abandoned` row. Reopening is a separate explicit act,
  `update-queue --objective-code <code> --status open`, by the row's filer or
  the Regent. No reap reason sets a row to `open`.
- **A row that was not released says so.** When the target is a campaign Alpha
  (its `identity.md` role is Alpha and its `spawn.json` carries an
  `objective_code`) and the reason maps to a row status (`completed`,
  `superseded`, `completed-unpublishable`, `abandoned`, `force`), but no
  in-flight row is recorded under its name, the reap still tears the agent
  down, then prints `reap-agent: "<name>" was torn down (...), but its queue
  row was NOT released — <reason>.` on stderr and exits 1. It never prints
  `Reaped ...` in that case. A Shadow carries its Alpha's objective code but
  never owns a row, so a Shadow reap stays quiet. After any release, read the
  row with `throne render-queue` and report the status it shows; never claim a
  row was released or will relaunch without that read. In one launch the agent
  was reaped while its spawn was still running, the reap printed `Reaped`
  beside a one-line linkage note, the row was reported released, and a minute
  later the spawn marked the row in flight under the dead name.
- **A reaped agent's launch never claims its row.** `create-agent`'s launch
  write-back first checks that the agent's ledger is still in
  `~/.throne/data/<name>/` and that herdr still lists it. If either is gone it
  writes nothing and prints `create-agent: queue linkage not recorded for
  "<name>" — <reason>.`
- **Completion push hook.** A successful `--reason completed` reap evaluates the
  notification predicate in `src/notify-lord/notification.service.ts`: completed **Alphas** notify by
  default, and completed **Shadows** notify only when
  `THRONE_NOTIFY_SHADOWS=1`. The posting target is
  `THRONE_NTFY_SERVER_URL` / `THRONE_NTFY_TOPIC` or the defaults baked into
  `src/notify-lord/notification.service.ts`. See `agent_docs/ntfy-phone-notifications.md` for the live
  server/topic contract and operator steps.

- **Abandoned-unmerged archival is explicit.** The single supported replacement
  for the historical manual `tree-base.json` rename is:

  ```bash
  ./bin/throne-cli reap-agent <name> --reason abandoned --archive-abandoned-unmerged
  ```

  Never rename provenance by hand. This mode inherits every normal Regent,
  liveness, and live-child refusal gate. `--force` retains its narrow
  meaning: it is only the live-agent/live-child override and can kill
  genuinely working agents. Agent memory lives outside every worktree (see
  `memory-dir`), so reap has nothing of it to protect. In particular,
  `--reason completed` is not an abandonment shortcut: it requires the ordinary
  merged-branch cleanup path.

- **Strict abandonment preflight.** Before any lifecycle mutation,
  abandoned-unmerged archival requires readable, structurally complete, name-matching
  target-repository provenance; an exact existing local `refs/heads/<name>`
  with a full object ID; and proof that the tip is intentionally **not**
  reachable from the recorded merge-target branch (`tree-base.json` `branch`;
  an absent merge-target branch refuses outright). The initial preflight refuses a
  merged, missing, corrupt, mismatched, foreign, or duplicate-checkout
  candidate before closing the tab or mutating the worktree or ledger. The ref
  may be checked out only in its one dedicated managed worktree; the retained
  target checkout, a foreign checkout, or duplicate checkouts refuse. A retry
  after the dedicated worktree was already removed is allowed only when all of
  the same ref/provenance proofs still hold.
- **Post-preflight race boundary.** After preflight succeeds, the accepted
  teardown closes the eligible live tab and removes the dedicated worktree
  before preserving provenance and re-verifying the unchanged unmerged ref and
  tip. If the ref moves after preflight, archival refuses at that verification
  stage — after tab/worktree teardown — while the moved ref and preserved
  `tree-base.abandoned-unmerged.json` marker remain in the live ledger for
  recovery with the explicit archival command. This is distinct from an
  initial proof failure, which leaves tab, worktree, and ledger untouched.
- **Abandonment disposition.** After preflight succeeds, reap closes the
  eligible live tab, removes the dedicated worktree, and preserves the original
  `tree-base.json` bytes byte-for-byte as
  `tree-base.abandoned-unmerged.json` (or verifies that marker is unchanged on
  retry). It then re-verifies the unchanged unmerged ref and tip. After that
  post-teardown verification succeeds, it records the `abandoned` timing reason
  and rotates the complete ledger under `~/.throne/data/.reaped/`. It emits a prominent
  `ABANDONED-UNMERGED` result
  that names the retained `refs/heads/<name>` and its exact tip. It does
  **not** merge, run `git branch -d` or `git branch -D`, delete a ref with
  `update-ref`, delete a remote ref, rename the recovery branch, or add a
  same-name reuse bypass.
- **`--force` reaps carrying a different reason share the mechanism, not the
  vocabulary.** The ancestry guard also blocks a `--force` reap whose
  `--reason` is anything other than `abandoned` — commonly a history-rewrite
  transplant campaign whose content already landed, so its commits are never
  literally reachable from the target. That case retains the branch through
  the identical mechanism above (ref kept, not merged or deleted, name reuse
  blocked, ledger archived complete) but is reported as `UNMERGED-RETAINED`,
  never `ABANDONED-UNMERGED` — that label, and the "abandoned" framing, is
  reserved for the explicit `--reason abandoned --archive-abandoned-unmerged`
  form. The timing row still records the caller's actual `--reason`
  untouched either way, so `agent-stats` reads it correctly regardless of
  which label was printed.
- **Retry and recovery boundary.** Before archival, the preserved provenance
  marker makes a partial failure recoverable: retry the same explicit
  archival command. Ordinary reap sees a live
  `tree-base.abandoned-unmerged.json` marker as an in-progress abandonment
  lifecycle and refuses with the exact retry command; it never treats that
  marker as missing branch authority. Ambiguous or changed provenance still
  refuses. The preserved local ref intentionally blocks exact
  `spawn-git-tree <name>` reuse until an operator inspects and deliberately
  resolves it. Start a new lifecycle name for non-destructive continued work;
  the throne never force-deletes the retained recovery branch on the operator's
  behalf.

- **Idempotency is mode-specific.** Ordinary reap treats an already-gone
  branch, worktree, or data dir as a clean no-op success. Explicit
  abandoned-unmerged archival instead requires live `tree-base.json` or preserved
  `tree-base.abandoned-unmerged.json` authority until archival succeeds; after
  successful ledger archival, rerunning the archival command is an
  authority failure, not the ordinary already-gone no-op path.
- **Exact branch ownership.** Branch cleanup is authorized only by a readable,
  structurally complete `~/.throne/data/<name>/tree-base.json` whose canonical `name`
  exactly equals `<name>` and whose `repo` identifies the target project. The
  candidate is that canonical name; reap never searches other repos or sweeps
  similarly named branches. A missing/unreadable record authorizes no deletion.
  A legacy exact record without `repo` preserves the branch, warns that the name
  may not yet be reusable, and keeps the old worktree/archive behavior. A
  readable corrupt or mismatched record refuses before teardown mutation.
- **Merged and not checked out.** Before closing a live tab, reap proves the exact
  local branch tip is reachable from the recorded merge-target branch
  (`tree-base.json` `branch`) in the recorded repo. When that target has been
  deleted, ordinary orphan cleanup instead requires the exact tip to be retained
  by the repository's durable default branch — resolved from
  `refs/remotes/origin/HEAD` and its matching local branch, never from a
  checkout's `HEAD` — refusing when that authority is unresolvable; `--force` explicitly
  authorizes cleanup without that retention proof. An unmerged tip while the
  recorded target still exists, a
  branch checked out in the retained target worktree, or duplicate registered
  checkouts is retained and refused. After worktree removal, deletion rechecks
  the tip, recorded-branch reachability, and that no checkout remains, then
  uses `git branch -D`: git's own `-d` proves merged-ness against `HEAD` — the
  wrong base for a Shadow that lands in its Alpha branch — so the recorded or
  default-branch retention proof replaces it. Remote deletion and cross-repo
  scans are never used.
- **Ancestry alone cannot prove "delivered" for a transplant, and the guard's
  message says so.** The guard's sole evidence for reachability is `git
merge-base --is-ancestor <branch tip> <merge-target tip>`
  (`src/git-lifecycle/branch-authority.ts`, `requireReachableFromMergeTarget`).
  That proves delivery for an ordinary campaign that lands by merging its
  branch into a live target branch, because the target's history then
  contains the campaign's commits by construction. Since the history-rewrite
  delivery mode ("MIG") was introduced, a campaign may instead deliver by
  **transplanting** its delta onto whatever main looks like at delivery time —
  a rebase/cherry-pick-style reapplication, not a merge — which lands the
  intended content on the target but produces new commits with new hashes;
  the original campaign branch's own commits are never literally reachable
  from the target, merged or not. A fully and correctly delivered
  transplant-mode campaign therefore still fails this ancestry check. The
  guard's refusal message names both possible causes (unlanded work vs.
  transplant delivery) and does **not** tell the operator to merge the branch
  to satisfy it — following that advice on a transplant-delivered campaign
  would merge the branch's original, pre-scrub commit history (which can
  carry a scrubbed operator username) into shared history the transplant was
  specifically used to avoid polluting. Instead the message points at the
  safe paths: confirm which delivery mode actually landed the campaign
  (content diff/manifest against the target, not branch ancestry), then rerun
  with `--force` to complete teardown while preserving the branch as a
  recovery ref if the content is already confirmed landed, or with
  `--archive-abandoned-unmerged` if the branch carries genuine unlanded unique
  work. The ancestry check itself is unchanged and still refuses a branch
  with real unlanded work; teaching the guard to detect content-equivalence
  directly (so the transplant shape above no longer needs the operator's
  manual confirmation step) was considered and declined as unneeded
  machinery — a correctly-transplanted campaign whose branch ends up an
  ancestor of the target (the common shape) already reaps cleanly with no
  guard change, and a general content-equivalence proof has no robust
  definition once renames, reformatting, or partial delivery are possible.
- **Transactional teardown.** Accepted order is tab close → git worktree removal
  → proven branch deletion → existing timing/notification hooks → ledger archive.
  A branch-delete failure keeps or recreates the preflighted ref, restores a
  clean dedicated worktree when practical, and leaves `~/.throne/data/<name>/` live for
  retry. An archive failure likewise leaves the ledger live; the deleted branch
  was already proven reachable from the recorded merge-target branch, so its
  commit is still recoverable and a retry treats the absent branch idempotently.
- **Ordinary archive rotation enables reuse.** Successful archive paths are
  `~/.throne/data/.reaped/<name>/`, then `<name>-2`, `<name>-3`, and so on without changing
  earlier contents. Ordinary successful git cleanup removes the dedicated local
  branch, so real `spawn-git-tree <name>` and fresh `identity.md` / `spawn.json`
  registration can reuse the exact canonical name independently of old archives.
  Abandoned-unmerged archival deliberately retains the local ref and therefore
  remains an exact-name reuse barrier.
- **Safe.** It normally **refuses to reap a LIVE agent** without `--force` and
  touches nothing when it refuses. The one plain-reap exception is
  **completion-proven but stuck**: `REPORT.md` landed and herdr reports any
  status except `working`, meaning the finished agent could not self-exit. That
  path prints a loud `completion-proven` note, closes the tab first, and reaps
  without force. A report-less LIVE agent, or a report-landed LIVE agent still
  marked `working`, remains refused and requires `reap-agent <name> --force`.
  A dead/complete agent (no live process) reaps freely. If the roster or needed
  completion probe cannot be read, plain reap refuses rather than guessing.
  When forcing a live agent, the tab is closed FIRST and the whole reap aborts
  if that fails — a live process never has its worktree pulled out from under it.
- **Child-aware.** Before any mutation, reap finds registered agents whose
  identity names the target as supervisor. Any LIVE child makes plain reap
  refuse with the child's status and exact remediation; this applies even when
  the parent itself is DEAD or COMPLETE. `--force` recursively force-reaps LIVE
  descendants depth-first before the parent and aborts the parent if any child
  fails. A cycle refuses loudly. Force may kill genuinely-working children, so
  inspect the listed agents before using it. Non-live children never block and
  are listed after a successful teardown with a completion-sweep suggestion.
- **A runtime-model mismatch is reported, never refused.** A stderr warning names
  the observed model, the spawn.json model and the evidence file, and the reap proceeds; see "The
  runtime-model gate and who it quarantines".
- **The Regent is protected.** `reap-agent Regent` (any case) is refused
  unconditionally — the Regent is managed by the self-heal watchdog
  (summon/dismiss), and `~/.throne/data/regent/` holds the durable QUEUE.

### Curing a failed autoscale launch ("launch history unresolved")

An autoscale launch that failed part-way leaves a `launch` line for its Alpha
in `~/.throne/data/regent/alpha-launch-ledger.jsonl` with no `status` line
after it. `create-agent` links the queue row in flight only when the launch
succeeds, so the row is still `open`, and every autoscale tick that selects it
refuses with `launch history unresolved for "<alpha>"`. One sequence clears it
and leaves the row launchable:

1. Check the Alpha is not still starting: `throne agent-statuses` must not
   show it as `STARTING`. A starting Alpha is not a failed launch; wait for its
   spawn to finish or the 300 s bound to pass. An empty composer alone proves
   nothing. If the half-spawned Alpha left a harness tab behind, close it:
   `herdr tab close <tab>`.
2. `throne reap-agent <alpha> --reason abandoned --force` tears the
   half-spawned Alpha down and appends the ledger's `abandoned` status line,
   which clears "launch history unresolved". The row was never linked to the
   Alpha, so the reap prints that the row was NOT released and exits 1; the
   teardown and the ledger line still happened. Confirm with
   `throne render-queue` that the row is `open`; the next tick launches it
   again. If the row was linked in flight to that Alpha, the same reap closes
   it as `abandoned`, exits 0, and the next tick launches nothing for it.
3. `throne update-queue --objective-code <code> --status open` is the
   explicit reopen: it reopens a row the reap closed and is harmless on a row
   that is already `open`. Either way the next tick launches the row.

## complete-agent

```bash
./bin/throne-cli complete-agent <name>   # reap one finished agent
./bin/throne-cli complete-agent --all     # sweep every finished agent
```

Reap-on-complete: the SAFE teardown of a **finished** agent. Its durable signal
is a `REPORT.md` landed in `~/.throne/data/<name>/`. A gone process has the roster's
**COMPLETE** lifecycle; a process that remains LIVE but no longer reports
`working` is completion-proven and stuck unable to self-exit. Both delegate a
plain teardown to `reap-agent` — never a blanket force. The roster supplies both
`lifecycle` and `reportLanded`; `reap-agent` owns teardown, so this command
re-implements neither.

- **Reaps a COMPLETE agent.** A completed agent is not live, so `reap-agent`'s
  liveness gate passes and no `--force` is needed.
- **Reaps a done-but-stuck LIVE agent** when `reportLanded` is true and herdr's
  status is anything except `working`. The success output calls out the
  completion-proven teardown; the delegated reap remains plain, with no force.
- **Preserves the child gate.** Its delegated plain reap still refuses when the
  completed parent has LIVE children and propagates that failure. Complete or
  reap the listed children first; `complete-agent` never upgrades itself to a
  forced cascade.
- **Refuses every other LIVE agent.** A report-less agent keeps the existing
  refusal. A report-landed agent still marked `working` is actively working:
  wait and retry, or explicitly run `reap-agent <name> --force` (exit 1,
  touches nothing).
- **Refuses a DEAD agent** — registered, process gone, but with **no** completion
  report: it died mid-work, not complete (exit 1). Resuming-or-reaping such an
  orphan is the Regent's call (objective D2), not this command's; a deliberate
  teardown is `reap-agent --force`.
- **Idempotent.** An unknown or already-reaped name is a clean no-op success —
  the same contract `reap-agent` gives an already-gone agent.
- **A runtime-model mismatch is reported, never refused.** A stderr warning names
  the observed model, the spawn.json model and the evidence file, and the completion proceeds; see "The
  runtime-model gate and who it quarantines".
- **The Regent is protected** — refused early here (and `reap-agent` hard-refuses
  it too).
- **Refuses an Alpha whose campaign is not on the Lord's page.** Before any
  reap, single or `--all`, it asks the `check-where-i-stand` decision about the
  agent and, while that refuses, prints its sentence and reaps nothing (exit
  1). `reap-agent --force` is not gated by it.
- **`--all` sweeps** every COMPLETE agent plus every completion-proven,
  non-working LIVE agent in one pass. It skips working-LIVE and DEAD agents and
  is failure-isolated: one bad reap never suppresses the rest, and the aggregate
  exit is non-zero if any reap failed. It is a manual sweep, not a background
  auto-reaper — nothing is torn down behind an operator's back.

## spawn-git-tree

```bash
./bin/throne-cli spawn-git-tree <name> [--repo <path>] [--base <ref>] [--alpha <name>] [--non-campaign]
```

Creates a git worktree for a coding slice of a **target project dir** (`--repo`,
default: the throne's own; resolved to its git root via `git rev-parse
--show-toplevel`; omitting `--repo` still works for throne self-work but warns
loudly and names the resolved throne repo, so cross-repo campaigns must pass
it), placed under the throne-owned `~/.throne/worktrees/<repo-basename>/<name>` —
**outside the target repo**, never a host for throne scaffolding (overridable
via `THRONE_WORKTREES_HOME`).

**A filed base the local branch does not contain is refused.** When the
target branch already exists locally and its tip differs from `--base`, the
tree still forks from the tip if the tip contains the base (the branch simply
moved on). If it does not, because the local branch is stale or has diverged
from what was filed, nothing is created and the refusal names both commits and
the `git branch -f` that fixes a branch not checked out anywhere.

**The base depends on the tree kind.** A name shaped `shadow-<code>-…` is a
**campaign Shadow**: its base is its supervising **Alpha's branch** (the branch
whose name equals the Alpha agent name), so the whole campaign accumulates on
that one branch instead of braiding each slice into the target. The Alpha is
resolved either from an explicit `--alpha <name>` (which must name a registered
Alpha whose durable objective evidence admits this Shadow name) or, absent the
flag, by scanning registered Alphas for the one whose campaign code equals the
`<code>` in the Shadow name; **zero or multiple matches refuse**, with a message
naming both remedies (`--alpha <name>` and `--non-campaign`). The resolved
Alpha's branch must exist in the target repo, and when that Alpha recorded a
`repo` its root must equal this spawn's target repo — a mismatch refuses (it
catches a Shadow pointed at the wrong `--repo`). Every other name — Alpha trees,
infrastructure — bases on the target repo's current branch+commit, or `--base
<ref>`. `--non-campaign` is the one loud override: it forces current-branch
basing for a deliberate `shadow-*` infra tree and records the opt-out. `--base`
on a campaign name refuses unless `--non-campaign` is also passed (the mandate
owns the base). **ALL validation runs before any write**, so any refusal leaves
no worktree, no branch, and no `tree-base.json` behind.

After `git worktree add`, the tree hydrates only explicit, ignored dependency
directories from the target project: npm/pnpm/Yarn `node_modules`, Python
`.venv`, Rust/Maven `target`, Swift `.build`, Dart `.dart_tool`, Ruby
`vendor/bundle`, PHP `vendor`, CocoaPods `Pods`, and Gradle `.gradle`. Defaults
come from the selected ecosystems; a project may override them with
`data/gittree.dependency-hydration.json` containing `ecosystems` and/or `paths`.
Paths must be relative, contained, non-secret, non-runtime, and non-symlink
through every existing parent. Existing destinations are preserved. Copies are
independent, including dereferenced nested symlinks, and never shared mutable
symlinks. The legacy `data/gittree.reflink-dirs.json` array remains readable
only for compatibility. The command records the base AND the resolved target repo in `~/.throne/data/<name>/tree-base.json`
(`repo` field; a campaign Shadow additionally records `branch` = the Alpha
branch it merges back into and `commit` = that branch's tip, while
`--non-campaign` records a `nonCampaign: true` marker), and prints the tree's
project dir to work in. The reflink allowlist is overridable via that target
project's own `data/gittree.reflink-dirs.json` (JSON array of dir names). Merge
back with `merge-git-tree` (below), which stash → merge → unstashes over a dirty
target and resolves any unstash conflict rather than clobbering.

## accept-slice

```bash
throne accept-slice [--data-dir <path>] [--bypass-supervisor-check] <shadow>
```

How a no-merge campaign's Alpha accepts a verdict-only Shadow's slice. It
replaces the hand-written "treat this as your merge confirmation" message.
It writes `data/<shadow>/acceptance.json` (`how: "verdict"`) and sends the
Shadow, through the message queue, the go-ahead to publish its reapability
claim. It never calls `merge-git-tree`, never commits and never touches git.
Only the Shadow's recorded supervisor may run it; anyone else is refused, and
the refusal names `--bypass-supervisor-check`. A failed send is recorded as
`sendOutcome: "failed"` and exits 1, so the caller knows to send the go-ahead
by hand.

## merge-git-tree

```bash
./bin/throne-cli merge-git-tree <name> [<message>]
```

The other half of `spawn-git-tree`: delivers branch `<name>` to the repo and
branch recorded in `~/.throne/data/<name>/tree-base.json`. Missing/legacy target metadata
fails closed; the command never guesses from the current checkout.

After a successful delivery of a Shadow's tree (identity role Shadow with a
recorded supervisor), the command records the acceptance in
`data/<shadow>/acceptance.json` (`how: "merge"`) and sends the Shadow the
go-ahead to publish its reapability claim through the message queue. A failed
send is recorded and printed, and the merge still stands.

Delivery creates exactly one commit, single-parented by the target branch's
latest tip, sharing `make-squash-commit`'s squash algorithm
(`buildSquashPreview`) rather than a two-parent merge. It reuses an existing,
non-stale `SquashPreviewRecord` for `<name>` when one was already built by
`make-squash-commit`; otherwise `<message>` is required and builds one fresh.
A preview is stale — and delivery refuses, naming which SHA moved — if either
branch's tip has moved since the preview was built. The candidate branch must
still exist (reap-before-squash precondition) or delivery refuses outright.
The target is fast-forwarded/CAS'd onto the delivery commit first, then the
candidate branch is force-moved onto the same commit (not a fast-forward: the
squash commit is parented by the target, not the candidate's own history).
Complete Git trees are preserved, including deletions, renames, modes,
symlinks, binary blobs, and submodules. An empty net diff succeeds as an
evidenced no-op without an empty commit. Repository `commit.gpgsign` policy is
honored; signing failure publishes nothing.

For a completed ordinary agent, a no-net-change result is accepted only when
one authoritative decision validates its live, non-symlink `REPORT.md` against
the same named identity, spawn objective, supervising Alpha, recorded tree, and
merge target. Missing, empty, malformed, foreign, stale, or contradictory
evidence still triggers the lost-commit refusal. This completion-time route is
also the supported recovery path for retained report-only agents: run the same
ordinary `merge-git-tree <name> "<verdict summary>"` command after this version
is installed; successful validation publishes the normal completion stamp, so
plain `complete-agent` can consume the agent afterward. Do not edit archived
records, force reap, manufacture content, or use raw Git.

Spawn-time `deliverable_shape: "verdict-only"` remains an independently working
compatibility route. It may be retired only after ten consecutive campaigns use
the completion-time route without fallback, both accepted and refused evidence
cases have occurred in operation, a caller audit finds no remaining dependency,
and the Regent deliberately approves removal.

When the target branch is checked out, dirty tracked/untracked work is stashed,
the one delivery commit is fast-forwarded, then the ambient work is restored
with user bytes winning any overlap. When it is checked out nowhere, the branch
ref advances by compare-and-swap without touching a checkout. Re-running
delivery after a crash between the target and candidate moves is idempotent:
it detects the target already carries the delivery commit and finishes only
the candidate move, never re-squashing. The command never rewrites
candidate/target history and never uses `git reset --hard` on the target. Its
success message reports either the delivery commit (with the pre-squash
candidate SHA, the only route back to it after the squash) or the explicit
no-op.

## keep-going

```bash
./bin/throne-cli keep-going [--name <name>]
```

Background heartbeat. Without `--name`, it first reads desired state, resolves
the uniquely named live Regent, and if running sends the Regent literal `read
~/.throne/data/regent/QUEUE.md, queue and dispatch more
work as necessary, check for stalled agents and poke them, and continue any
active work` through the common submit engine with explicit sender
`keep-going`, so the recipient-visible row begins `keep-going said: ...` and
never depends on current-agent inference. If the Regent is dismissed, it
no-ops. If no live Regent exists while desired state is running, it resurrects
one instead of sending, before reading any provider sensor. With `--name
<agent>`, it skips desired-state and resurrection entirely: a named Regent
gets the same queue-aware literal, and any other named agent gets the
preserved generic nudge, still with sender `keep-going`. It does not read,
evaluate, reconcile, or dispatch itself, and it exits non-zero only on genuine
ambiguity or resolution failure. Sends nothing on ambiguity or resolution
failure. Direct calls and the tracked systemd service both reach the common
submit engine, so they share the same per-pane kernel critical section with
every other producer.

**The standing nudge to a live Regent is off by default (Lord, 2026-09-21:
"`keep-going` doesn't need to message Regent anymore every 30 mins").**
`steering.regentHeartbeatNudgeEnabled` in `config.user.ts` turns it back on;
absent or `false` means a live Regent is sent nothing on the tick. The switch
is read fresh on every tick, so flipping it needs no backend restart. Three
things do NOT depend on it: the tick itself still runs, because it is what
feeds the systemd watchdog; a dead Regent with desired state `running` is
still resurrected; and a stalled family is still reported to a live Regent,
since that is news rather than a heartbeat. `keep-going --name <agent>` by
hand is unaffected.

On the default live-Regent path, `keep-going` passes the exact live
`HerdrAgent.agent` label into the throttle evaluator. `codex` selects only the
Codex/GPT usage getter, `claude` only the Claude getter, `opencode` only the
opencode-go getter, and opposite-provider telemetry cannot change cadence.
Matching-provider pressure
still obeys the existing hysteresis bands, progressive finite slowdown, and
never-full-stop law. A harness change or legacy driverless throttle state
starts a fresh pacing domain — persisted band and `lastNudgeAt` from one
provider never gate the other; only same-driver matching-sensor unavailability
may retain that driver's prior band. A live label outside `HARNESSES` reads no
provider getter, records explicit unsupported-driver evidence, and nudges once
at NORMAL/unthrottled cadence; the same unavailable-telemetry contract covers
an `opencode` Regent, whose unreadable opencode-go reading keeps the prior band
and never suppresses the heartbeat. A throttle-evaluation failure nudges
unthrottled (NORMAL); a state-read failure can still compute a matching
non-NORMAL band; a state-write failure can retain a computed non-NORMAL band —
no failure ever suppresses the heartbeat. Output is byte-identical to the plain
nudge only when
the evaluated band carries no advisory: the pinned literal, optionally
followed by a single space and that one band's advisory text, and nothing
else. A non-Regent `--name` target never receives a band advisory.

## check-in-flight-rows

```bash
./bin/throne-cli check-in-flight-rows
```

Lists every queue row whose status is `in-flight` while the Alpha recorded on
it is neither live in herdr nor still starting (spawn not finished and younger
than the starting bound `agent-statuses` and `reap-agent` use). Each line names
the objective code, the recorded agent and that agent's state: `DEAD`,
`COMPLETE`, `reaped` (its ledger was archived under `data/.reaped/`) or
`never registered`. Exit 1 when any such row exists, 0 with a `none found`
line otherwise. It reads the queue store, the agent roster and spawn records,
and changes nothing: it never moves a row's status and never launches an
Alpha, and the autoscaler's selection is unchanged.

The same findings ride on `keep-going`'s Regent nudge, under "In-flight rows
with no live Alpha", on every tick while they exist, even when the standing
heartbeat nudge is off. There is no "already reported" memory: a row stays in
the report until someone fixes it, for example by relaunching its Alpha or
moving the row with `update-queue` after reading it back with `render-queue`.

## add-to-queue

```bash
./bin/throne-cli add-to-queue [--objective-code <code>] [--effort <level>] [--single-slice] <body words...>
```

Writes one new `open`-status item to the SQLite-backed Regent queue store
(`src/regent-queue/`). Every non-flag argument joins into the item's prose
body, space-separated; `--objective-code` (optional, may appear anywhere
among the arguments) keys the item by objective code instead of a generated
id. Prints the inserted item's id and status on success; a missing body is a
hard error (non-zero exit, store never opened).

`--single-slice` (on the Lord's own word, or his standing ruling for a
read-only artefact row) stores the row as single-slice; the autoscaler then
launches its Alpha with `create-agent --single-slice` (/execute-todos
"Single-slice mode"). `--shadowless` and `--sliceless` are refused with a
message naming their removal by the Lord on 2026-11-04, and nothing is
filed.

`--model-hint <harness>/<model>` records the Lord's model order for the
campaign. When the pair is outside the Alpha role pool (for example
`claude/opus` or `claude/fable`), filing also records that order as the
campaign's authorization: one entry per registry, authorizer `Lord`,
recipient `*` (every agent of that objective code), 30-day expiry, appended to
`<throne data home>/regent/bypass-model-authorizations.json` and
`bypass-usage-authorizations.json`. Re-filing the same objective replaces its
entry rather than adding a second; other entries are left alone. The
autoscaler then passes `--bypass-model --bypass-usage` on its next tick with
no Regent step, and create-agent adds the hint's pair to the Alpha's
`model-allowlist.json` so its Shadows can use it. A hint inside the Alpha pool
writes nothing. An exact-recipient entry the Regent writes by hand still wins
over the `*` entry for that recipient. Rows filed before this change still
need the hand procedure in `agent_docs/MODEL_POLICY.md`.

`--pr-branch <name>` records the branch a pull request will be opened FROM
(rendered as `pr: <name>` in the queue and carried into the launch brief; also
settable later with `update-queue --pr-branch`, cleared with
`--clear-pr-branch`). For a PR-shaped campaign the Stager creates that branch
from the repository's default branch first, or from the other pull request's
branch when the work builds on another open pull request
(`.claude/skills/queue-objective/SKILL.md`, "Prefer stacking"), and files it as
`--target-branch` as well, so delivery lands on it and `99c` opens the draft PR from it (see
`.claude/skills/execute-todos/SKILL.md`, "Pull-request delivery"). The name is
the human contributor's — `add/<feature>`, `fix/<bug>` — never an agent name,
an objective code or any throne machinery (Lord, 2026-09-08).

`--effort <level>` records the reasoning effort the Lord ordered for the
campaign, stored in the row's nullable `effort` column and shown by
`render-queue`. It takes a number 1–6 or a level name: `low` 1, `medium` 2,
`high` 3, `xhigh` 4, `max` 5, the same numbers the launch uses (6 is claude
`ultracode`, codex `ultra`). Anything else is
refused with a plain message, and `update-queue --effort <level>` uses the same
parser; `update-queue --clear-effort` removes it. The autoscaler launches a row
with an effort as `create-agent --effort <n> --bypass-effort`, the bypass
derived from that row alone, and a row without one launches with neither flag.
The Alpha records it as its campaign effort in `identity.md` and `spawn.json`,
and each Shadow it spawns runs at that effort without a flag; a different
explicit `--effort` on a Shadow still needs `--bypass-effort`. The Stager
passes it only on the Lord's own words for that objective.

**Admitted for the `Stager` role only (Lord, 2026-08-21).** An Alpha, a
Shadow, or the Regent invoking this command is refused and nothing is added;
see AGENTS.md, "The Stager" → "Only a Stager files queue objectives" for the
reasoning. The check reads the calling agent's own `identity.md` Role line via
`isQueueFilerRoleName` and fails CLOSED: an unresolvable caller or an
unreadable role is a refusal, not an admission. The refusal text names the
route that remains — report the finding to your supervisor and let the Lord
decide whether it becomes an objective.

## lint-queue-plan

```bash
./bin/throne-cli lint-queue-plan --objective-code <code> | --body-file <path>
```

The mechanical half of the Stager consolidation checklist (AGENTS.md, "The
Stager"): checks a consolidated plan body for the four canonical section
markers — `INTENT:`, `SCOPE:`, `RULINGS:`, `VERIFIED-NOUNS:` — before the
Stager files the objective and notifies the Regent as launch-ready.
`--objective-code` reads the item's body from the SQLite queue store;
`--body-file` lints a draft before filing. Read-only in both modes. Failure
text is deliberately teaching-grade (names the missing marker, what belongs
under it, an example) because downstream agents follow error text literally.
A pass proves structure only and says so — whether decisions were genuinely
closed with the Lord and nouns genuinely grep-verified stays the filing
Stager's judgment, and this lint is not evidence of it.

## amendment

```bash
./bin/throne-cli amendment --objective-code <code> --words-of <whose words> (--text <text> | --text-file <path>) [--relayed-by <agent>]
```

Records the Lord's change to a filed queue row as a numbered `AMENDMENT <n>`
in the queue store's `queue_amendments` table, beside the row rather than
inside its body, and tells whoever must act on it. Only a Stager or the
Regent may run it. What happens depends on the row:

- **open or deferred**: recorded only. The launching Alpha receives every
  recorded amendment in full in its `## Situation at launch` section.
- **in flight, not yet finished**: recorded, then a pointer under 400
  characters goes to the row's Alpha and to the Regent (not to the Regent
  when it is the caller). Shadows are never messaged; the Alpha relays.
- **delivered** (a delivery commit is recorded), **complete**, **abandoned**,
  or its Alpha has written `REPORT.md`: refused, nothing recorded, with the
  delivered branch named so the caller can file a new objective against it.
- **no such row**: refused.

Exit `0` recorded and everyone told, `1` refused, `2` recorded but at least
one recipient was not told (the message names who and why). `render-queue`
prints each amendment under its row's body. The `/amendment` skill is the
usage guide.

## update-queue: deferring a row

```bash
./bin/throne-cli update-queue --objective-code <code> --status deferred --depends-on <code>[,<code>...] --defer-reason "<why it is held>"
```

`--status deferred` requires both `--depends-on` (the objective codes the row
waits on) and `--defer-reason` (why it is held); either one alone, or either
flag without `--status deferred`, is refused and nothing is written. The row
records when it became deferred; re-deferring an already deferred row to
change what it waits on keeps that time. `update-queue` refuses to move a
deferred row to `open` and names `release-deferred`, the only way a deferred
row starts. Moving a deferred row to `abandoned` still works.

## release-deferred

```bash
./bin/throne-cli release-deferred --objective-code <code> --reason "<why it may start now>" [--requested-by <agent>]
```

Moves one `deferred` queue row to `open`. The row is then launch-eligible
exactly when it already carries its launch facts; releasing invents none. It
records on the row who asked (`--requested-by`, or nobody), who released it,
the reason and when, and the record stays on the row after it moves on. It
writes one `queue_mutation_audit` entry in the same transaction. With
`--requested-by`, it then sends that agent one message,
`Released <code>: <reason>`, through `send-agent`.

Only the Regent, or the Stager that filed the row (`add-to-queue` records
the filer's name), may run it. Anyone else, an unidentifiable caller, a
missing row, or a row that is not `deferred` is refused, and nothing is
written. Exit `0` released (and the requester told), `1` refused, `2`
released but the reply could not be sent; the message names the requester
and the text to send by hand.

## check-jscpd

```bash
./bin/throne-cli check-jscpd
```

Prints the jscpd version pinned in `vendor-pins.json` (`harnesses.jscpd`), the
version of the vendored `vendor/node_modules/.bin/jscpd`, and which `jscpd`
`PATH` resolves to. The version is the last token of `jscpd --version`. Exit
`0` only when the vendored version is the pinned one and `PATH` resolves
`jscpd` to the throne's `bin/jscpd` shim. Exit `1` when the vendored binary is
missing, older or newer, or its version line cannot be read (it then names
`./install.sh`'s vendored harness step), or when a different `jscpd` comes
first on `PATH` (it then prints that path).

## check-queue-amendments-reconciled

```bash
./bin/throne-cli check-queue-amendments-reconciled --agent <alpha name>
```

Exit `0` when the Alpha's plan records every amendment on its queue row as
reconciled, `66` when it does not, `1` on a malformed invocation. The plan's
record is the last `**Queue amendments reconciled through:** <n>` line in the
newest `todo-*/00_overview.md` under the Alpha's ledger. A row with no amendments,
or an agent with no queue objective code, always passes. The `bin/git` push
guard calls it for an Alpha after its gate checks pass (a missing
`throne-cli` beside the shim is warned about, not blocking), and
`merge-git-tree` calls the same check before landing an Alpha's branch.

## situation-brief

```bash
./bin/throne-cli situation-brief --objective-code <code>
```

Prints what a newly launched Alpha should know about the world around its
queue row: every recorded amendment in full; the target repository's local
tip, remote tip and how they differ, whether the local tip contains the filed
base, other worktrees holding the branch, and uncommitted changes in the main
checkout; other queue rows on the same repository or branch that are live or
finished within 7 days, with their `RULINGS:` lines; open pull requests on the
same branch or touching a file the body names (through `gh`); and the position
of every commit hash the body cites. A row with no repository gets only the
queue sections; a missing network or `gh` prints "unavailable" for that part.
Everything except the amendments is kept under 4 KB, dropping the oldest
lines first. `create-agent` appends the same text under
`## Situation at launch` to a fresh Alpha's opening prompt when it launches for
a queue row; a brief that cannot be composed never blocks the launch.

## mark-queue-launch-eligible

```bash
./bin/throne-cli mark-queue-launch-eligible --objective-code <code> \
  --alpha-name <name> --target-repo <path> --target-branch <branch> \
  --base-commit <commit>
```

Marks one existing open queue objective as launch-eligible and writes all four
launch facts atomically. The objective code uses the same canonical validation
as `add-to-queue`; missing metadata, an absent objective, or a non-open row
fails without changing the row. The command records launch intent only: the
existing auto-brief/floor path remains responsible for briefing and spawning.

The routine actor is the intentional filer, normally the Stager after it has
consolidated a launchable plan. The Regent may use the command for compatibility,
but is not the routine eligibility gate. Eligibility means the filer possesses
one canonical objective code and all four structured launch facts. Prose is
never interpreted as launch intent because queue prose also contains rulings,
corrections, and observations that must remain ineligible. Supplying the same
structured fields to `add-to-queue` remains the preferred one-step filing path;
this command supports existing rows and workflows where filing and launch
approval happen separately.

A successful mark commits the row to consideration by the alpha-autoscale
worker at its next five-minute floor tick; it is not an immediate launch request.
Operational proofs must therefore reserve and observe the whole tick window,
not infer safety from a momentarily free machine. This command has no revoke
mode. The separately tracked `eligrace` work owns atomic eligibility revocation
plus expiry of any derived launch brief; clearing only the eligibility bit would
leave stale launch authority behind.

## trim-queue

```bash
./bin/throne-cli trim-queue [--apply]
```

Operates on the SQLite-backed Regent queue store, not `QUEUE.md` prose.
Safe by default: with no flag it's a dry run that reports every terminal
(`complete`/`abandoned`) item a real trim would remove, without mutating the
store. `--apply --actor <actor>` performs the archive — preserving full bodies and audit metadata while removing exactly the terminal items,
through the store's attributed archive boundary. A non-terminal item (`open`/`in-flight`) is
never removable regardless of flags: "terminal" is decided once, by
`TERMINAL_QUEUE_ITEM_STATUSES` in `regent-queue-item-state.ts`, never
reimplemented here. An empty store or a store with no terminal items prints a
"nothing to trim" message and exits 0. A store the read layer reports as
`unknown` (could not read) is a hard error (non-zero exit) — never silently
treated as empty.

## work-log

```bash
./bin/throne-cli work-log --since <date> [--json]
```

Answers "what happened since <date>" without reading reports or transcripts.
`--since` takes an ISO date (`2026-10-06`, local midnight) or date-time
(`2026-10-06T09:00`); the window runs from it to now. Read-only: it opens the
queue store as `render-queue` does and writes nothing.

- **Queue rows:** every row whose `completed_at` or `updated_at` falls in the
  window, oldest update first, with its objective code, status, recorded
  outcome (`not recorded` when the row has none), outcome summary, pull
  request URL, result commit, completion and update times, and the first
  sentence of its `INTENT:` section.
- **GitHub actions:** every line of
  `<THRONE_DATA_HOME or ~/.throne>/data/github-actions.jsonl` (the gh guard's
  mutation log) whose `timestamp` falls in the window. A missing file means no
  actions yet; a malformed line is skipped and counted.

`--json` prints one object: `since` (ISO-8601), `rows` (each with
`objectiveCode`, `status`, `outcome`, `outcomeSummary`, `prUrl`,
`resultCommit`, `completedAt`, `updatedAt`, `intent`; an unrecorded field is
`null`), `githubActions` (the log lines as written) and
`malformedGithubActionLines`. Exit 0 listed, 1 a store or log that could not
be read, 2 an unknown flag, a missing `--since` or a value that is not an ISO
date.

## preview

```bash
./bin/throne-cli preview add <path or port> --address <address on this machine>
./bin/throne-cli preview add <path or port> --folder <folder>
./bin/throne-cli preview remove <path or port>
./bin/throne-cli preview list
```

Edits the `previews` list in the real `config.user.ts`, keeping every other key
and comment, then applies it at once (`docs/CONFIG.md`, "`previews`"). `add`
creates the file holding only the list when there is none, and prints the
tailnet URL. `list` prints one line per entry: URL, `live` or `not live`, and
what it shows. Publishing goes through the same code as the `tailnet-publishing`
worker, and only ever calls `tailscale serve`.

The ledger of what this code created is `<throne home>/state/tailnet-routes.json`.
A place on the tailnet that is not in it is refused, naming what holds it, and
left alone, so tailnet-preview's paths are never touched. A port with funnel
enabled is refused too. `remove` refuses a place that is not in the list.

Exit 0 done, 1 refused or failed with nothing further changed, 2 a command that
makes no sense.

## where-i-stand

```bash
./bin/throne-cli where-i-stand list
./bin/throne-cli where-i-stand show
./bin/throne-cli where-i-stand put --code <code> --section-id <id from list> --listing-token <token from list> (--text-file <file> | --text "<entry body>")
./bin/throne-cli where-i-stand put --code <code> --remove
./bin/throne-cli where-i-stand note "<one line>"
./bin/throne-cli where-i-stand archive <row or section id>
./bin/throne-cli where-i-stand restore <row or section id>
./bin/throne-cli where-i-stand purge [--dry-run]
./bin/throne-cli where-i-stand add-tab --name "<tab name>" --listing-token <token from list>
./bin/throne-cli where-i-stand add-section --tab-id <id> [--parent-id <section id>] --name "<section name>" --listing-token <token from list>
```

Writes and reads the Lord's page: tabs, sections (optionally nested) and rows
in the throne database, `<THRONE_DATA_HOME or ~/.throne>/where-i-stand.sqlite3`,
owned by throne-backend. Every action reaches throne-backend over REST; add
`--local` to open the database in this process instead, for when the backend
is not reachable. Every write is journaled with the caller's agent identity
as writer; no action takes a date, and every row carries the dates the
database set when it was written, changed and archived. Nothing is deleted
except by the six-month purge.

- **`list`** prints every tab and section with its short id, archived ones
  marked, each with its exact dates, and a listing token: a fingerprint of
  the structure. Run it before any add.
- **`show`** prints the page as Markdown generated from the database, every
  row with its exact dates. It is read-only; there is no file to edit.
- **`put --code <code> --section-id <id> --listing-token <token>`** writes one
  entry `### <code>` into that section and archives every other current row
  with the same code. It refuses a token from before the structure last
  changed, printing the current listing; an entry not starting with the
  `- Links:`, `- Kind:` and `- Where it stands:` lines, naming the missing
  one; and a section name in place of an id, for every section. Adding to an
  archived section revives the section and says so. `--remove` archives the
  entry with that code.
- **`note "<one line>"`** adds an event to `## Just happened`; the newest 15
  stay and older ones are archived.
- **`archive <id>`** and **`restore <id>`** archive or restore a row or a
  section; a section is archived with everything in it.
- **`purge`** deletes for good every row and section archived for more than
  six months, with what is archived inside it; the journal keeps its record.
  The backend runs it on its minute tick and on every write. `--dry-run`
  lists what would go and deletes nothing.
- **`add-tab`** and **`add-section`** create a tab or a section with the
  current listing token. A name that matches a sibling's, ignoring case and
  surrounding spaces, is refused, or revives that sibling when it is archived,
  and the command says so.

`## Delivered, not on GitHub` keeps its newest 20 entries and every entry
younger than 3 days; every write archives the rest.

## check-where-i-stand

```bash
./bin/throne-cli check-where-i-stand --agent <alpha name>
```

Answers one question: has this Alpha's campaign recorded its outcome on the
Lord's page? It holds when the page's journal has a record, made by
the Alpha or by one of its Shadows (a name beginning
`shadow-<objective code>-`), later than the Alpha's delivery time, whose
`added` or `changed` names the entry `<objective code>`, and the page as it
stands does not hold that entry under `## In flight` and starts every entry
`<objective code>` with its `- Links: ` line. The delivery time is the
modification time of `REPORT.md` in the Alpha's ledger, so one `put` of the
entry after the report satisfies it, and no earlier change
is needed. Editing `REPORT.md` afterwards moves the delivery time forward and
the entry has to be written again.

It also refuses while an older entry about the same work stands
uncorrected. Two entries are about the same work when their `- Links: ` lines
share a Forgejo or GitHub pull request URL, a Forgejo URL and a GitHub URL
counting as one when any entry on the page carries both, or, when neither has
a pull request, name the same ticket (not `no ticket`) and the same commit or
branch, compared as written. Such an entry is older when the newest journal
record naming it is earlier than the newest one naming `<objective code>`, or
when no journal record names it, and it stands uncorrected unless it carries a
line beginning ``Superseded by `### ``. The check reads only the page and its
journal; it calls no network.

It passes without an entry for an agent that is not an Alpha, an agent with no
objective code, and an Alpha whose queue row is abandoned. It reads no plan
bundle, so an Alpha with no plan bundle is judged the same way. When it refuses
it prints one sentence saying what to do: write `REPORT.md` first, write the
entry `### <objective code>` under `## Delivered, not on GitHub` or
`## On GitHub`, move that entry out of `## In flight`, start that entry
with its links line directly under its heading, or correct each older entry
about the same work, naming its `### ` heading and quoting its
`- Where it stands:` line (its links line when it has none) and saying to
remove the entry or correct that line and add
``Superseded by `### <objective code>` on <date>``.

`complete-agent` asks the same decision before it reaps and refuses an Alpha
with the same sentence. Exit 0 recorded or nothing owed; 1 an invocation that
is not exactly `--agent <name>`; 66 not recorded. It only reads.

## semaphore

```bash
./bin/throne-cli semaphore create <name> --slots <n>
./bin/throne-cli semaphore run <name> -- <command> [args...]
./bin/throne-cli semaphore status [<name>] [--json]
```

One general counting semaphore for any tool that must not run too many copies
at once. Each semaphore lives in
`<THRONE_DATA_HOME or ~/.throne>/semaphores/<name>/`: its slot count in the
file `slots`, written to a temporary file and renamed into place, and one lock
file per slot, `slot-<i>.lock`, numbered from 1. A name is ASCII letters,
digits and dashes; a slot count is a positive whole number.

- **`create <name> --slots <n>`** records that `<name>` has `<n>` slots.
  Running it again on an existing name changes the count; slots already held
  stay held. Lowering the count below the number held never disturbs a
  running holder: slots above the new count are simply never taken again.
- **`run <name> -- <command> [args...]`** takes the first free slot from 1 up
  to the current count, runs the command with standard input, output and
  error passed straight through, frees the slot when the command ends, and
  exits with the command's own exit code, or 128 plus the signal number when
  it died of a signal. With every slot held it prints one line on standard
  error, `throne semaphore: waiting for a free slot of "<name>" (<n> slots,
  all held)`, tries again every second and takes the first slot that frees;
  there is no queue, so waiters are not served in order. SIGINT, SIGTERM and
  SIGHUP sent to `run` are passed to the command, so Ctrl-C or an agent's
  timeout stops the real command. Once the command starts, its pid, command
  line and start time are written into the slot's lock row.
- **`status [<name>] [--json]`** lists each semaphore (or the named one), its
  slot count, and for every held slot, including one above a lowered count,
  the holder's pid, command line and start time. `--json` prints
  `{"semaphores": [{"name", "slots", "heldSlots": [{"slot", "holder":
  {"pid", "commandLine", "startedAt"}}]}]}`.

A slot is a lock row in `locks.sqlite3` that records both the `throne
semaphore run` process and the command, which runs in its own process group.
The slot stays held while either the runner or any process in the command's
group is alive, so **the slot stays held until the command itself exits, even
if the `throne semaphore run` process is killed with SIGKILL**. A child the
command starts stays in its group and keeps the slot too. The next taker
deletes a row whose runner and command group are both gone.

For ffmpeg, which runs out of memory when too many encodes run at once:

```bash
throne semaphore create ffmpeg --slots 4
throne semaphore run ffmpeg -- ffmpeg -i clip.mov clip.mp4
```

Exit codes: `create` and `status` exit 0 on success; `status <name>` exits 1
when the semaphore does not exist, so a wrapper can decide to create it. 2 is
an invalid invocation: an unknown action or flag, a bad name or slot count, a
missing command after `--`, or `run` on a semaphore that does not exist (the
message gives the `create` command to run). `run` otherwise exits with the
command's code, 128 plus its signal number, or 127 when the command could not
be started.

## git-identity

```bash
./bin/throne-cli git-identity [--repo <path>] [--remote <origin url>]
```

Prints the git author identity the court signs with for one repository, as
`<name>\t<email>\t<signing key>\t<openpgp|ssh>`, read fresh from the live
throne `config.user.ts` `identity` section on every call. **Signing is
mandatory (Lord, 2026-09-08):** every identity carries a `signingKey` (a gpg
key id, or an ssh public-key path with `signingFormat: 'ssh'`; a named
identity inherits the top-level key when it names none), and an identity
without one is treated as unset — exit 3, and the shim's STOP. The section
carries a default pair and, optionally, named alternatives selected by the
repository's `origin`
(`host` or `host:owner`, matched case-insensitively against ssh, scp and
https URLs; `host:owner` beats `host`; `default` names the top-level pair; no
match or no origin falls back to the default):

```ts
identity: {
  name: 'Full Name', email: 'me@example.com', signingKey: '0123456789ABCDEF0123456789ABCDEF01234567',
  identities: { work: { name: 'Full Name', email: 'me@examplecorp.example', signingKey: '<same or another key id>' } },
  remotes: {
    'github.com:example-owner': 'default',
    'github.example-corp.com': 'work',
    'github.com:ExampleCorp': 'work',
  },
},
```

`--repo` (default: the cwd) reads the origin with `git remote get-url origin`;
`--remote` supplies the URL directly. Exit 3 when nothing applies, 1 when the
file cannot be loaded, 2 (steered) on an unknown argument. The same
resolution is the identity every tab is born with: `src/herdr/herdr-tab.service.ts`
resolves it for the tab's cwd at `herdr tab create` and exports
`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL`,
the signing configuration as git's own env-injected config
(`GIT_CONFIG_COUNT=4` with `user.signingkey`, `commit.gpgsign=true`,
`tag.gpgsign=true`, `gpg.format`), `THRONE_GIT_SIGNING_KEY`/
`THRONE_GIT_SIGNING_FORMAT`, plus `THRONE_GIT_IDENTITY_ORIGIN` (the origin
it was chosen for) on the tab,
next to the `<throne>/bin`-first `PATH`, so git signs natively and no global
or per-repo git config is ever written. The `bin/git` shim is the backstop:
before `commit`, `merge`, `cherry-pick`, `revert`, `am` and `rebase` it trusts
those variables only while the repository's origin equals
`THRONE_GIT_IDENTITY_ORIGIN` and a signing key is exported, pinning
`-c user.signingkey=… -c commit.gpgsign=true -c tag.gpgsign=true -c gpg.format=…`
on the command line so no repository-level `commit.gpgsign=false` can switch
signing off; for any other repository (or a tab spawned before the section
was filled) it asks this command with `--repo` and injects the identity AND
the signing flags, clearing the tab's variables so the re-resolved identity
wins; a configured identity without a key is a STOP that names the signing
key; and when nothing is configured it inspects the identity git would use; a
machine-local one — empty, no `@`, `localhost`, `*.local`/`*.lan`/single-label
domains, or the host's own name — is refused with exit 66 and a **STOP RIGHT
THERE** that tells the agent to ask the Lord (via its supervisor) for the two
lines, exactly as a missing `gh` login is handled (Lord, 2026-09-08). An
explicit `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` in the environment is
honoured and skips the guard.

**The shim also closes the fast route to origin for an Alpha (Lord, 2026-09-10).**
Before `push`, when the repository's top level lies under
`$THRONE_DATA_HOME/worktrees/` and the ledger at
`$THRONE_DATA_HOME/data/<basename>/identity.md` says `- **Role:** Alpha`, the
push to any named remote or URL is refused with exit 66 unless the newest
`todo-*` bundle in that ledger holds a `99a_*.md` whose execution log recorded
`**Conformance outcome:** PASS` and a `99b_*.md` that recorded
`**Verify outcome:** PASS` (line-anchored, so the template's own mention of
the line does not count). Pushes to a local path (`/…`, `./…`, `file://…`),
which is how the yolo checkpoint reaches `$CLAUDE_BACKUP_PATH`, are never
guarded; nor are Shadow worktrees or checkouts outside the throne's worktree
root. The refusal names the missing gate and tells the Alpha to run the
chain or message the Regent. It exists because on 2026-09-10 an Alpha
skipped `/write-and-execute-todos` entirely, wrote, tested and pushed a fix
inline four minutes after spawning, and only the Regent's review caught it:
a brief is prose and can be skipped whole, a refused push cannot. The same
incident added the `Execution mode:` line to every Alpha's identity.md,
stated both ways (`single-slice (Lord-authorized)` or `shadowed (default)`),
so the mode is never implied by absence. A single-slice Alpha is held to the
same bundle path as every other Alpha.

## push-waiver

```bash
./bin/throne-cli push-waiver --repo <dir> --remote <name> --ref <local branch> --findings-file <file> --entries-file <file>
```

The one sanctioned way for a court session to skip the push checks (Lord,
2026-10-05). When the checks configured in `push-check.command` block a push,
the pushing agent alone may certify, finding by finding, that nothing they
reported is a defect in the branch it is pushing, and record that proof as a
waiver. The waiver lets exactly one push skip the checks: the commit `--ref`
points to when the waiver is written, pushed to the same-named branch on
`--remote`, once. A finding that fits none of the three reasons below is
fixed, not waived.

`--findings-file` is the blocked push's own report, saved from the push's
stderr: one finding per non-blank line, a severity word first and a
`path:line` token in it, or the check's JSON when it has one (an array, or an
object with a `findings` array, of objects with a severity, a `file` or
`path`, a `line`, and a `title` or `message`). Findings are numbered from 1 in
file order. `--entries-file` is a JSON array with exactly one entry per
finding, `{ "finding": <number>, "reason": <kind>, … }`, where the reason is
one of three kinds and each kind carries its own evidence:

| Reason | When | Evidence |
|---|---|---|
| `other-open-pr` | The finding is about code another open PR adds. | `pr` (a positive whole number), `commit` (that PR's head, fetched so it resolves locally), `location` (the `path:line` on that head that provides it). |
| `already-on-base` | The behaviour exists unchanged on the base branch. | `commit` (the base commit), `location` (the `path:line` where the same code is). |
| `finding-wrong` | The code already does what the finding says it does not. | `location` (a `path:line` in the pushed commit) or `test` (the name of a test that passes; recorded, not run). |

An invented example: a "review-bot" check blocks a push of a recipe app's
`add/ratings-page` branch with three findings.

```text
high src/api/recipes.ts:42 Calls GET /api/ratings, which the server does not serve
medium src/views/RecipeList.tsx:88 Load more retries silently on failure
low src/views/RatingStars.tsx:12 Half stars are not rounded
```

```json
[
  { "finding": 1, "reason": "other-open-pr", "pr": 41, "commit": "<head commit of PR 41>", "location": "server/routes/ratings.ts:17" },
  { "finding": 2, "reason": "already-on-base", "commit": "<base commit>", "location": "src/views/RecipeList.tsx:88" },
  { "finding": 3, "reason": "finding-wrong", "test": "half stars round to the nearest half" }
]
```

The command refuses, writing nothing, when the repository is not a court
checkout (its top level must lie under `$THRONE_DATA_HOME/worktrees/`,
default `~/.throne`, with `$THRONE_DATA_HOME/data/<basename>/identity.md`
present; the basename is the agent), when `--remote` is not a configured
remote or `--ref` is not a local branch, when a findings line or the findings
JSON is malformed, when any finding has no entry or two, when an entry names a
finding that does not exist or a reason outside the three kinds (the refusal
lists the allowed kinds), or when evidence is empty or malformed: a commit
that does not resolve, or a `path:line` whose file is missing at that commit or
has fewer lines. Each refusal names the finding and what is wrong with it.

On success it writes the waiver record under
`$THRONE_DATA_HOME/data/<agent>/push-waivers/`, keyed by remote, branch and
commit, holding the agent, repository, remote, branch, commit, when it was
written, the parsed findings and the entries. It prints the record's path,
one line per finding (`finding N: <severity> <path:line> <title> — <reason>:
<evidence>`), and the one push command to run:

```bash
git -C <repo> push --no-verify <remote> <branch>
```

Run that command as printed, without `--bypass` (`PUSH_CHECK_SKIP=1` in place
of `--no-verify` is admitted the same way). The `bin/git` guard admits the
skip only when the pushing agent's own ledger holds an unspent waiver written
by that agent for that remote, for a push whose single refspec is that branch
name, and the branch still points at the waived commit. It then marks the
waiver used, keeping the record on disk, and prints
`throne git guard: push checks skipped under waiver <path>`. A spent waiver is
never reused: the replay, a different commit, a different branch, another
agent's waiver, and a skip with no waiver are all refused with exit 68, and
the refusal names `throne push-waiver`. A new commit needs a new check run
and, if that is blocked too, a new waiver. The record's path and its entries
go into the DONE report and into any PR-delivery report.

## forge

```bash
./bin/throne-cli forge status <number|url|branch> [--repo <path>] [--json]
./bin/throne-cli forge check-media-links <pull request url> [--repo <path>] [--json]
./bin/throne-cli forge open <number|url|branch> [--repo <path>] [--editor <cmd>] [--print]
./bin/throne-cli forge open --cleanup [--repo <path>]
./bin/throne-cli forge ensure-repository [--base <branch>] [--repo <path>]
./bin/throne-cli forge push-branch --branch <name> [--base <branch>] [--repo <path>]
./bin/throne-cli forge sync-branches [--repo <path>]
./bin/throne-cli forge pr create --title <title> --body-file <path> --base <branch> --head <branch> [--draft] [--repo <path>] [--bypass]
./bin/throne-cli forge pr view <number|url|branch> [--repo <path>] [--bypass]
./bin/throne-cli forge pr edit <number|url|branch> [--title <title>] [--body-file <path>] [--repo <path>] [--bypass]
./bin/throne-cli forge pr list [--limit <n>] [--repo <path>] [--bypass]
./bin/throne-cli forge pr diff <number|url|branch> [--repo <path>] [--bypass]
./bin/throne-cli forge pr merge <number|url|branch> --squash [--repo <path>] [--bypass]
./bin/throne-cli forge pr comment <number|url|branch> --body-file <path> [--repo <path>] [--bypass]
./bin/throne-cli forge attach <number|url|branch> --file <path> [--repo <path>]
./bin/throne-cli forge detach <number|url|branch> --url <attachment url> [--repo <path>]
./bin/throne-cli forge render-markdown --file <path> [--repo <path>] [--bypass]
./bin/throne-cli forge pr feedback <number|url|branch> [--repo <path>]
./bin/throne-cli forge pr answer <number|url|branch> --comment <id> --body-file <path> [--resolve] [--repo <path>]
./bin/throne-cli forge pr review <forgejo url|staged github url> --comments-file <path> [--repo <path>]
./bin/throne-cli forge pr review-findings <forgejo url|staged github url> --out <path> [--repo <path>]
./bin/throne-cli forge pr self-reviewed <forgejo url|staged github url> --head <sha> [--repo <path>]
./bin/throne-cli forge mirror-feedback <number|url|branch> [--repo <path>]
./bin/throne-cli forge promote <number|url|branch> [--repo <path>]
./bin/throne-cli forge land <number|url|branch> [--repo <path>]
./bin/throne-cli forge stage <github pull request url> [--repo <path>]
./bin/throne-cli forge close-merged-twin <number|url|branch> [--repo <path>]
```

The one place the court decides where a pull request lives and talks to it.
Skills call this instead of `gh` for pull-request work. `--repo` names the
local checkout and defaults to the current directory.

**Which forge the host uses.** Forgejo when the install marker
`${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/enabled` exists (the marker
`install-forgejo.sh` writes; see `agent_docs/forgejo.md`) and the instance at
`config/app.ini`'s `ROOT_URL` answers `GET /api/v1/version` within 5 s.
Otherwise GitHub. A marker whose Forgejo does not answer is a refusal (exit 1)
naming the URL and `systemctl --user status forgejo.service` (on a mac, the
`launchctl print` line for `com.throne.forgejo`). It never falls back to GitHub.

**Which forge a pull request belongs to.** A URL whose origin is the Forgejo
`ROOT_URL` origin, or `http://<tailnet ip>:8420` (the address from
`tailscale ip -4`), is Forgejo. A `github.com` URL is GitHub through `gh`; any
other host is GitHub Enterprise through `ghe`, the same choice the `pr-merge`
scripts make. A bare number or branch belongs to the repository's own forge,
which is the host's forge.

One exception, on a host with Forgejo installed: a GitHub pull request that
has an open Forgejo twin is STAGED and belongs to Forgejo. The twin is found
from Forgejo alone, never by reading GitHub: among the open pull requests of
the Forgejo copy named after the GitHub repository (owned by the Forgejo
admin, so it works from any directory), the one whose metadata comment names
that GitHub URL. Every operation that takes a target then works on the twin,
except `pr merge`: nothing is merged in Forgejo, so a staged pull request
merges on GitHub. A twin that has been closed is no longer found, so its
GitHub URL is plain GitHub again. A host without Forgejo makes no such read.

**The metadata comment.** Every staged Forgejo pull request carries exactly
one conversation comment, written by the Forgejo admin, that holds all the
bookkeeping between the twins (`src/forge/staging-metadata.ts`):

```
GitHub: <github pull request url>

<!-- github-twin: <github pull request url> -->
<!-- staging-sync: {"promotedHead":"<sha or null>","carriedAnswers":[<forgejo comment ids>]} -->
```

The first line is the visible link to the GitHub twin. `promotedHead` is the
head commit the last `promote` pushed, `null` until then. `carriedAnswers`
lists the Forgejo answers already carried back to GitHub. `stage`, `promote`
and repromote write it: the first write posts it and every later one rewrites
the same comment in place, so there is never a second one. An older comment in
the same place, such as `Promoted to GitHub: <url>` with only a `github-twin`
record, is rewritten into this shape. The Forgejo body carries no record, and
GitHub carries none at all: no body, title, reply or comment the forge code
sends to GitHub names Forgejo.

**`status`** prints every fact known about one pull request on both forges.
The target is a GitHub URL (github.com or GitHub Enterprise), a Forgejo URL, a
bare number or a branch. With `--json` it prints one object:

```
{
  "target":   { "asked", "kind": "github-url"|"forgejo-url"|"number"|"branch",
                "resolvedOn": "forgejo"|"github", "how" },
  "hostForge": "forgejo"|"github",
  "stage":    "forgejo-only"|"promoted"|"github-only"|"merged-on-github"|"closed",
  "forgejo":  { "url","number","state","draft","base","head","headSha" } | null,
  "github":   { "url","number","state","draft","base","head","headSha","mergedAt","mergeCommit" } | null,
  "inSync":   true|false|null,
  "publishTo": "forgejo"|"github",
  "mergeTarget": { "url","program": "gh"|"ghe","forgejoUrl" } | null,
  "mergeTargetRefusal": "<text>" | null,
  "crossHostMediaLinks": { "forgejo": ["<link>"], "github": ["<link>"] },
  "selfReview": { "reviewedHead": "<sha>" | null, "coversHead": true|false }
}
```

Without `--json` it prints the same facts as short `key: value` lines.
`target.asked` is the text given and `target.how` one sentence saying where it
was found. `hostForge` is the host's forge, decided as above. `state` on
either side is `OPEN`, `CLOSED` or `MERGED`; `mergedAt` is an ISO time or
`null` and `mergeCommit` the merge commit's sha or `null`. `inSync` is `true`
when the two head shas are equal, `false` when they differ, and `null` when
either side is missing. It writes nothing. It exits 0 when the pull request
was found on either forge; one found on neither is a refusal (exit 1) naming
where it looked.

- **Resolution.** A Forgejo URL reads that Forgejo pull request, and its
  GitHub twin through the metadata comment. A GitHub URL reads GitHub, and
  its Forgejo twin through the open pull requests of the Forgejo copy (the
  twin lookup above; a host without Forgejo makes no Forgejo read). A bare
  number or branch is looked up in the checkout's Forgejo copy first, and on
  the checkout's GitHub repository only when Forgejo has no such pull request
  or the host has no Forgejo. A number that exists on both forges therefore
  names the Forgejo one; pass the GitHub URL to address the other.
- **`stage`.** GitHub `MERGED` is `merged-on-github`; GitHub `CLOSED` is
  `closed`; GitHub `OPEN` is `promoted` when a Forgejo pull request is linked
  and `github-only` when none is. With no GitHub pull request, Forgejo `OPEN`
  is `forgejo-only` and anything else is `closed`.
- **`publishTo`** is where writes aimed at this pull request (pr-media's
  published media, pr-review's pending reviews) go. A GitHub URL is always
  `github`, whatever twin it has. A Forgejo URL is `forgejo`. A number or branch is `github` when the stage is
  `github-only` or `merged-on-github` or there is no Forgejo pull request, and
  `forgejo` otherwise.
- **`mergeTarget`** is the GitHub pull request a merge lands on, for
  `pr-merge`'s `stack.mjs`: its `url`, the `program` that reaches it, and the
  linked Forgejo pull request's URL as `forgejoUrl` (`null` when none is
  linked). Nothing is merged in Forgejo, so a Forgejo pull request with no
  GitHub twin has `mergeTarget` `null` and `mergeTargetRefusal` set to
  `<forgejo url> is not on GitHub yet: it has no metadata comment linking a
  GitHub pull request (it was never staged or promoted), and nothing is merged
  in Forgejo. It must be promoted first with /pr-promote on the Lord's word.`
  `mergeTargetRefusal` is `null` whenever `mergeTarget` is set. In a
  repository whose pull requests stay on Forgejo every Forgejo pull request has this `null`
  `mergeTarget`, and it lands through `land` instead (below).
- **`crossHostMediaLinks`** lists, for each side, the image and video links
  in that side's body that point at the other forge and so do not load
  there: GitHub-hosted media in the Forgejo body, and attachment or media
  links to this host's Forgejo in the GitHub body. A prose link to the twin
  pull request or to a commit is not listed. A side that does not exist has
  an empty list. The plain output prints one `crossHostMediaLinks.<side>.<n>`
  line per link and none when a list is empty.
- **`selfReview`** says whether the self-review recorded with
  `pr self-reviewed` still covers the Forgejo head. `reviewedHead` is the
  recorded head, `null` when none is recorded or there is no Forgejo pull
  request. `coversHead` is `true` when the recorded head is the head, or when
  it is an ancestor of the head and every commit since it that is not on the
  default branch (`refs/remotes/origin/HEAD`) is a merge with two parents, one
  of them on the default branch, whose tree is exactly what `git merge-tree
  --write-tree` gives for those two parents: a merge of the default branch
  that needed no conflict resolution. Anything else is `false`: no record, a
  force push past the recorded head, a fix, a hand-resolved conflict, or a
  merged-in upper pull request. The plain output prints it as
  `selfReview.reviewedHead` and `selfReview.coversHead` lines.

**`check-media-links`** reads both sides of a pull request exactly as
`status` does, from either side's URL, and prints only that finding: one
`<side>: <link>` line per link, `forgejo` or `github` in front, or
`no cross-host media links were found`. With `--json` it prints
`{"forgejo":[…],"github":[…]}`. It writes nothing. It exits 0 when both lists
are empty and 1 when either holds a link. `stage`, `promote` and a repromote
run the same check on the body they copied and refuse while a link remains
(below).

**`open`** opens one pull request in the user's editor, on either forge. It
resolves the target exactly as `status` does (same internals, `status`
unchanged), then:

- **Local clone.** First hit wins: `--repo`; the Forgejo checkouts registry
  (`${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/checkouts.json`,
  `owner/repo` to path); the court's known checkouts (queue rows' target
  repositories and recall's `repositories.json`) whose `origin` points at the
  pull request's repository. None is a refusal (exit 1): `no local clone of
  <owner/repo>; pass --repo or clone it`. It never clones.
- **Checkout.** Candidates are that clone's worktrees (`git worktree list`).
  A tree whose basename is a live agent's name (`herdr agent list`) or that is
  dirty (`git status --porcelain` not empty) is never touched, and each one
  skipped is printed with its reason. A finished or reaped agent's tree is
  fair game. In order: reuse a clean tree whose HEAD is the head sha; else
  fetch and move the detached HEAD of a clean earlier review tree for this
  pull request; else create the review tree `<checkout>-pr-<n>`
  (`<checkout>-<branch-slug>` for a branch target) beside the clone with
  `git worktree add --detach` at the head sha, fetched from the remote named
  `forgejo` when the head is held on Forgejo, else `origin`. A dirty review
  tree for this pull request is a refusal naming its path. It never checks
  out the branch, resets or stashes.
- **Editor.** `--editor <cmd>`, else `editor` in `config.user.ts`, else
  `$VISUAL`, else `code`, launched detached with the tree's path as its last
  argument, before anything is installed.
- **Dependencies.** Right after the editor starts, the court's dependency
  hydration (a copy from the clone when the manifests match, else a real
  install) runs as a detached background process logging to
  `${XDG_STATE_HOME:-$HOME/.local/state}/throne/forge-open/<tree basename>.log`;
  the log path is printed and the command returns without waiting. When the
  tree's dependencies are already current it starts nothing and prints
  `dependencies already current`.
- **`--print`** prints the path only and launches neither the editor nor the
  install.
- **`--cleanup`** (from any checkout of the repository, bare, main or linked,
  or `--repo`) acts only on the review trees `forge open` recorded: whenever
  `open` returns a review tree it writes the pull request's URL into that
  tree's private git directory. Cleanup reads each tree's status by that URL
  and removes, with `git worktree remove` and never `--force`, each one whose
  pull request is merged or closed. Every other worktree is kept and not
  listed, and a dirty review tree is reported, not removed.

**Credentials.** On a Forgejo host every API call reads the token from
`${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/api-token` (mode 0600, written
by `install-forgejo.sh`). The seam only reads it; a missing or empty file is a
refusal naming `install-forgejo.sh`. API calls send `Authorization: token …`.
A push to Forgejo passes `Authorization: Basic <admin>:<token>` to git as an
`http.extraHeader` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
in that one git process's environment, so the token is never in a remote URL,
`.git/config`, an argument list, stdout or a log line.

**The Forgejo copy of a repository (lazy mirror).** It is owned by the
Forgejo admin (`GET /api/v1/user`) and is private. Its name is the last path
segment of the local `origin` URL without `.git`, or the checkout directory's
name when there is no `origin`. The local `forgejo` remote,
`<ROOT_URL><admin>/<name>.git`, records that the copy exists.
`ensure-repository` acts on that one repository only. When the `forgejo`
remote exists and the Forgejo repository exists, it pushes nothing. Otherwise it
creates the repository, adds the remote and pushes the base branch: `--base`,
or the branch `refs/remotes/origin/HEAD` names (a refusal asks for `--base`
when there is none). Before it compares or pushes a base it fetches that
branch from GitHub with
`git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>`, an explicit
refspec, so a clone with no fetch refspec (a bare-backed one) is fetched too.
It then pushes the fetched `origin/<base>`, so neither a stale
remote-tracking ref nor a local base that is ahead of `origin` becomes the
Forgejo base. A base GitHub does not have, such as a stacked pull request's
base that exists only locally and in Forgejo, is pushed from the local
branch. Any other failed fetch, an unreachable GitHub included, is a refusal
(exit 1) that names the fetch, and nothing is pushed. It prints
`{"owner","name","created"}`. On a GitHub host it refuses, because a Forgejo
copy is only made where Forgejo is installed. Every forge command that
resolves a repository's Forgejo copy from a local checkout
(`ensure-repository`, `push-branch`, `pr create`, `sync-branches`) records
that checkout's path, which is how the backend's branch mirror finds it (see
`agent_docs/forgejo.md`, "Keeping Forgejo copies current").

**Drafts.** Forgejo has no draft flag. A draft is a title starting with
`WIP: `. `pr create --draft` adds it, and `pr view` and `pr list` report
`isDraft` from it and print the title without it.

**The GitHub number in a Forgejo title.** Every Forgejo pull request title
carries `[GH-<github number>]` right after any `WIP: ` prefix, before the
rest of the title: `WIP: [GH-123] Add the export button`. `[GH-##]` stands
in until a GitHub twin exists. `pr create` on Forgejo adds `[GH-##]`;
`stage` and `promote` set the number, taken from the GitHub URL's last path
segment. Writing a marker replaces any `[GH-...]` already in that place, so
it is never doubled. `pr view` and `pr list` print the title with its marker.
GitHub never receives it: on a host without Forgejo `pr create` sends the
title unchanged, and `promote` removes the marker from the title it sends.

**Operations.** Each one runs on the forge decided above. Every GitHub branch
runs the `gh` command the skills ran before this command existed. A caller's
`--bypass` is put first, for the `bin/gh` guard. The seam never adds
`--bypass` on its own. GitHub output and exit status pass through unchanged.

| operation | Forgejo | GitHub argv | prints |
| --- | --- | --- | --- |
| `push-branch` | ensure the copy, push the base branch as `ensure-repository` chooses it, then `git push forgejo refs/heads/<branch>:refs/heads/<branch>` | `git push -u origin <branch>` | Forgejo: `{"owner","name","created","branch"}`; GitHub: git's output |
| `pr create` | ensure the copy, push `--base` and `--head` as `push-branch` does, then return the open pull request with the same head and base, or open one (`POST /repos/{o}/{r}/pulls`) titled with `[GH-##]` after any `WIP: ` | `gh pr create [--draft] --base <b> --head <h> --title <t> --body-file <f>`; in a repository whose pull requests stay on Forgejo, refused before any GitHub call | the pull request URL |
| `pr view` | `GET /repos/{o}/{r}/pulls/{n}` | `gh pr view <target> --json number,url,title,body,state,isDraft,headRefName,baseRefName` | JSON with those fields; `state` is `OPEN`, `CLOSED` or `MERGED` |
| `pr edit` | `PATCH …/pulls/{n}` with only the fields given: the title from `--title`, taken verbatim, and the body from `--body-file`, keeping the current body's self-review record when the new body carries none; at least one is required | `gh pr edit <target>` with `--title <title>` and/or `--body-file <f>`; in a repository whose pull requests stay on Forgejo, refused before any GitHub call | the pull request URL |
| `pr list` | open pull requests (`GET …/pulls?state=open`) and each one's files; `[]` when the repository has no Forgejo copy | `gh pr list --state open --limit <n> --json number,title,headRefName,url,files` (default limit 30) | JSON array with those fields, `files` as `[{"path"}]` |
| `pr diff` | `GET …/pulls/{n}.diff` | `gh pr diff <target>` | the diff |
| `pr merge --squash` | in a repository whose pull requests stay on Forgejo, the `land` landing (below), with no GitHub call. Anywhere else refused before any write: nothing is merged in Forgejo, which is only the staging area; the refusal says to promote with `/pr-promote` on the Lord's word and merge the GitHub pull request. A staged GitHub URL is not sent to its twin; it merges on GitHub | `gh pr merge <target> --squash --delete-branch=false` | GitHub: gh's output; a landing prints `land`'s JSON line |
| `pr comment` | `POST /repos/{o}/{r}/issues/{n}/comments` | `gh pr comment <target> --body-file <f>`; in a repository whose pull requests stay on Forgejo, refused before any GitHub call | the comment URL |
| `attach` | `POST /repos/{o}/{r}/issues/{n}/assets` (multipart field `attachment`) | refused: GitHub has no upload that returns a URL; GitHub media goes through `pr-media`'s `gh pr edit --attach` publish | `{"url","markdown"}` |
| `detach` | the attachment of `GET /repos/{o}/{r}/issues/{n}/assets` whose `browser_download_url` is `--url`, deleted with `DELETE …/issues/{n}/assets/{id}`; nothing when the pull request has no such attachment | refused: GitHub has no API that removes an uploaded file | `{"detached"}`, `true` when an attachment was deleted |
| `render-markdown` | `POST /api/v1/markdown` with `{"Mode":"gfm","Text":…,"Context":"<admin>/<name>"}` | `gh api -X POST /markdown -f mode=gfm -f text=<file contents>` | the HTML |

A `<target>` is a number, a URL or a branch. On Forgejo a branch resolves to
the open pull request whose head is that branch. `attach` returns the
attachment's `browser_download_url` and the markdown that embeds it. An image
gets `![<name>](<url>)`. A `.mp4`, `.webm` or `.mov` gets
`<video src="<url>" title="<name>" controls></video>`, which is what
Forgejo's own "Copy link" button writes for a video. Forgejo 16.0.5's
sanitizer keeps `<video>` with `src` and `controls`
(`modules/markup/sanitizer.go`), so it plays inline. `<name>` is the file name
without its extension.

**Fresh base.** `push-branch` and `pr create` bring the Forgejo copy of the
base branch up to date every time, so a pull request opened after the base
moved is diffed against the moved base. They first fetch the base from
`origin` as `ensure-repository` does, refusing when that fetch fails, then
fetch the same branch from the `forgejo` remote and compare the two.
When the Forgejo copy already contains the base, for example after someone
committed to it by hand in Forgejo's web editor, nothing is pushed. When it is behind, the base
is pushed. The push is never forced: when the two have moved apart and
neither contains the other, the call refuses (exit 1) naming the branch and
both tips, and the Forgejo base is left as it was.

**Mirroring every branch.** `sync-branches` brings every GitHub branch onto
the repository's Forgejo copy, on a Forgejo host only (on a GitHub host it
refuses as `ensure-repository` does). When the repository has no Forgejo copy
it makes one first, exactly as `push-branch` does. It fetches every branch
`origin` advertises into `refs/remotes/origin/*` with an explicit refspec, no
tags and no pruning, so a bare-backed clone is fetched too. Then it compares
each GitHub branch with Forgejo's copy of it and acts on the outcome:

| outcome | Forgejo's copy | what happens |
| --- | --- | --- |
| created | missing | the branch is pushed |
| fast-forwarded | behind GitHub's | the branch is pushed; git itself refuses a push that would not fast-forward |
| current | equal to GitHub's | nothing |
| ahead | holds commits GitHub's lacks | left alone: rewinding it would need a force push |
| diverged | neither contains the other | left alone, logged on stderr and reported |

Every push is the same plain, never-forced push `push-branch` makes. A branch
Forgejo has and GitHub does not, such as a staged pull request's head, is
never pushed, rewritten or deleted, and nothing is ever deleted or pushed to
`origin`. The bases of open Forgejo pull requests go first, then the other
branches; a run where nothing moved pushes nothing. It prints one JSON object
that lists the branches under each outcome and every open pull request whose
base it could not bring current (ahead, diverged, or a failed push), with the
pull request's number, its base and the reason. An open pull request whose
base GitHub does not have has nothing to bring current and is never
reported as a failure.
It exits 0 when every branch was brought current or reported ahead or
diverged, 1 when any branch push failed (the JSON is still printed, every
failed branch under `failed` with git's reason), and 1 when the repository
could not be read or fetched, in which case nothing is pushed. These pushes
carry only commits `origin` already has, so the push checks skip them. The backend runs it for every recorded repository every 10 minutes
(`agent_docs/forgejo.md`, "Keeping Forgejo copies current").

**Staging a pull request on GitHub.** Forgejo is the Lord's staging area. A
pull request reaches GitHub only through `promote`, which only the
`/pr-promote` skill runs, on his word; `stage` brings a pull request that is
already on GitHub into Forgejo without writing to GitHub. Every record below
is hidden HTML in a Forgejo comment. Every title, body and reply sent to
GitHub has its records removed first and is refused, before any GitHub write,
when it still names the Forgejo host (its `ROOT_URL` host or the tailnet
address) or still holds a record. On a host with Forgejo that includes the
body file `pr edit` and `pr comment` send to a GitHub pull request.

| operation | what it does | prints |
| --- | --- | --- |
| `promote <forgejo pr>` | In a repository whose pull requests stay on Forgejo, does nothing: no call to either forge, prints `<repo> keeps its pull requests on Forgejo, so there is nothing to promote; land it with /pr-merge. Nothing was changed.` and exits 0. Otherwise it reads the Forgejo pull request live. Downloads every Forgejo attachment its body embeds (`GET …/issues/{n}/assets`, a `pr-media` anchor's name or the attachment's own name), and puts a `<!-- drop <name> here -->` placeholder where each was. Refuses before any GitHub write when the title or that body still names the Forgejo host or holds a record. Runs `git push -u origin <head>`. The first time, it runs `gh --bypass pr create [--draft] --base --head --title --body-file`, with the title without `WIP: ` or its `[GH-...]` marker and the body as it is, then writes the metadata comment with the GitHub URL and the pushed head as `promotedHead`, and sets the Forgejo title's marker to `[GH-<github number>]` (`PATCH …/pulls/{n}` with `{"title"}`, only when the title differs). Last, it runs `pr-media`'s `publish.mjs <github url> --folder <downloads>` (with `--stills-only` when there is no video), which uploads the files to GitHub and fills the placeholders. Then it reads the GitHub body back with `gh pr view <github url> --json …` (`ghe` on GitHub Enterprise) and refuses with exit 1, printing nothing on stdout, while it still holds a `<!-- drop <name> here -->` placeholder or an image or video link to the Forgejo host (the `check-media-links` finding); the refusal names the placeholders, each such link and `throne forge promote <forgejo url>` as the one command that finishes it. When the publish failed because nobody signed in within the wait, the refusal says so and names the same command; when it failed because the page fell back to `--wizard`, it keeps the downloads in `~/tmp/pr-media-<github number>/` (a fresh sibling folder when that exists) and names `bun <pr-media>/publish.mjs <github url> --folder <kept folder> --wizard`. | `{"forgejoUrl","githubUrl","created","mergedOnGithub","answers"}` |
| `promote` again (repromote) | Finds the metadata comment and opens nothing. Pushes the head, replaces the GitHub body through `gh --bypass pr edit <url> --body-file`, records the pushed head as `promotedHead`, sets `[GH-<github number>]` on the Forgejo title when it does not already carry it, and re-hosts the media the same way. Then carries back every Forgejo answer to a mirrored item that GitHub does not yet hold: in a thread through `gh --bypass api repos/{o}/{r}/pulls/{n}/comments -f body=… -F in_reply_to=<first comment id>`, otherwise through `gh --bypass api repos/{o}/{r}/issues/{n}/comments -f body=…`. The answer goes with its records removed and nothing added. After each reply the answer's Forgejo id joins `carriedAnswers` in the metadata comment, which is how a later run knows it was sent; `mirror-feedback` likewise skips a GitHub comment whose text is exactly a carried answer, so it is never mirrored back as new feedback. Repromote never carries a `pr review` review or its copy-paste comment; those reach GitHub only through `pr review-findings`. Finally it resolves, with the `resolveReviewThread` GraphQL mutation, each GitHub thread whose Forgejo twin is resolved. Running it again sends nothing twice. | the same; `answers` is `{"replied":[forgejo ids],"resolved":[thread ids]}` |
| `promote` once the GitHub twin is merged | Finds the metadata comment and reads `gh pr view <url> --json state`. When it is `MERGED` (someone merged it on GitHub directly), it does not repromote: it pushes nothing and opens or edits nothing on GitHub. It closes the Forgejo pull request as `close-merged-twin` does. | the same, with `"mergedOnGithub": true` and empty `answers`; every other run prints `false` |
| `stage <github pr>` | Stages an existing GitHub pull request in Forgejo, on a Forgejo host only. Reads it with `gh pr view <url> --json number,url,title,body,state,isDraft,headRefName,baseRefName`. When it already has an open Forgejo twin, it only writes the metadata comment (rewriting an older shape in place), sets `[GH-<github number>]` on the twin's title when it does not already carry it, runs the media link check below on the twin's body, and stops. Otherwise it refuses, changing nothing, unless the head branch exists locally as `refs/heads/<head>`, and names `git fetch origin <head>:<head>`. It opens the twin as `pr create` does: ensures the copy, pushes the base and the head, and opens the Forgejo pull request titled `[GH-<github number>] <github title>` (`WIP: [GH-<github number>] <github title>` for a draft) and the live GitHub body with its records removed. When the push is refused by a review pre-push hook that names `AI_REVIEW_HOOK_BASE`, the refusal names `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>` and the rerun `AI_REVIEW_HOOK_BASE=origin/<base> throne forge stage <url>`. Every GitHub-hosted image and video the body embeds (`<any GitHub host>/user-attachments/assets/…`, `user-images.githubusercontent.com/…`) is downloaded with `gh api <url>` (`ghe api` on GitHub Enterprise), replaced by a `<!-- drop <name> here -->` placeholder, and attached to the twin through `pr-media`'s `publish.mjs <forgejo url> --folder <downloads>`; a link whose download is refused stays in the body as it was. Then it writes the metadata comment (`promotedHead` `null`) and runs `mirror-feedback` once. Last, it reads the twin's body back and refuses with exit 1, printing nothing on stdout, while it still holds a GitHub-hosted image or video link (the `check-media-links` finding): the twin stays open with everything above done, and the refusal names the twin, each link and `/pr-media publish <twin url>` as the one command that repairs it, followed by `mirror-feedback`'s report line for each media link in a comment that run mirrored. Writes nothing to GitHub. | `{"githubUrl","twinUrl","created","mediaLinksInMirroredComments"}`; `created` is `false` when the twin already existed; the last field is `mirror-feedback`'s, empty when nothing was mirrored |
| `close-merged-twin <github or forgejo pr>` | The one operation that closes a Forgejo pull request whose GitHub twin is merged; `pr-merge` runs it right after merging a staged root, and `promote` uses it when it finds the twin merged. Takes a staged pull request by either URL; a pull request with no metadata comment is refused. Reads `gh pr view <github url> --json state` and refuses unless it is `MERGED`. Then, only when the Forgejo pull request is still open, it posts `This pull request has been merged on the GitHub side: <github url>` (`POST …/issues/{n}/comments`) and closes it (`PATCH …/pulls/{n}` with `{"state":"closed"}`), never merging it. An already closed twin gets no second comment. Writes nothing to GitHub. | `{"forgejoUrl","githubUrl","closed"}`; `closed` is `false` when it was already closed |
| `mirror-feedback <github or forgejo pr>` | Takes a staged pull request by either URL; a Forgejo one with no metadata comment is refused. Reads the GitHub feedback with `threads.mjs`'s `dumpFeedback`, so the given pull request and its rolled-in layers are covered. It mirrors every unresolved thread, every conversation comment, every review body and each bot's latest report that the twin does not already hold, with `<!-- github-feedback: <kind> <pr> <id> -->`. A thread whose line is in the twin's diff becomes a review comment on that file and line (`POST …/pulls/{n}/reviews`, event `COMMENT`). Any other item becomes a conversation comment, and a thread's comment names its file and line. A GitHub-hosted image or video link in a comment it mirrored does not load in Forgejo and no command re-hosts a comment's media, so each one is reported, in the printed JSON and as one stderr line naming the link and the GitHub comment where it can be seen, and the exit status stays 0. Writes nothing to GitHub. | `{"githubUrl","twinUrl","mirrored","alreadyMirrored","mediaLinksInMirroredComments"}`; the first two lists hold GitHub keys, the last `{"link","githubCommentUrl"}` |
| `pr feedback <pr>` | Lists the Forgejo pull request's conversation comments, review bodies and review comments (`GET …/issues/{n}/comments`, `…/pulls/{n}/reviews`, `…/reviews/{id}/comments`). A staged GitHub URL reads its twin; a GitHub pull request that was never staged is refused, because `threads.mjs` reads those. | JSON array of `{"id","kind","author","place","reviewId","resolved","url","body","githubKey","answers"}`; `kind` is `comment`, `review` or `review-comment`; `place` is `{"path","line","onOldSide"}` and `reviewId` the review holding the comment, both `null` for anything but a review comment |
| `pr review <pr> --comments-file <f>` | Posts a code review on the Forgejo pull request; a staged GitHub URL posts on its twin, and a GitHub pull request that was never staged is refused, naming `throne forge stage <url>`. `<f>` is the `[{"path","line","body","start_line"?}]` array `pr-review`'s `pending-review.mjs` takes, checked by that script's own `validateComments`; an empty or invalid file is refused before any write. Every body goes through the GitHub-bound check first (records removed, refused when it names the Forgejo host), so a finding that could not reach GitHub is refused with nothing written. Then one review, event `COMMENT`, holds every finding as a line comment on the new side (`POST …/pulls/{n}/reviews`), each body ending with `<!-- pr-review: finding -->`; Forgejo's review API has no line range, so a range is commented on its last line. Last, it writes the one copy-paste conversation comment: for each finding a bold `` `path:line` `` heading (`path:start_line-line` for a range) and the body, findings separated by `---`, ending with `<!-- pr-review: copy -->`. A later run rewrites that comment in place (`PATCH …/issues/comments/{id}`) instead of adding a second. Writes nothing to GitHub. | `{"reviewId","reviewUrl","copyCommentUrl","head"}`; `head` is the Forgejo pull request's head commit |
| `pr review-findings <pr> --out <f>` | In a repository whose pull requests stay on Forgejo, refused with nothing written, naming the key. Otherwise takes a staged pull request by either URL; one with no metadata comment is refused. Reads the line comments holding `<!-- pr-review: finding -->` of the latest such review as they stand now, so an edit the Lord made in Forgejo is kept and a comment he deleted is gone, and writes them to `<f>` as the array `pending-review.mjs` takes, each body through the GitHub-bound check. A range comes back as its last line only. A pull request with no such review is refused with nothing written. `mirror-feedback` and `stage` skip a GitHub comment whose text is exactly one of these findings, so a review the Lord submitted on GitHub is never mirrored back as new feedback. Writes nothing to GitHub. | `{"count","githubUrl"}` |
| `pr self-reviewed <pr> --head <sha>` | Records that a self-review covered `<sha>` (a full 40-character commit sha; anything else is refused with nothing written) on the Forgejo pull request; a staged GitHub URL records on its twin, and a GitHub pull request that was never staged is refused, naming `throne forge stage <url>`. The record is the hidden `<!-- self-review: <sha> -->` in the Forgejo pull request's own body, written through the same body `PATCH` as `pr edit`: a later run replaces it in place, and the rest of the body is left exactly as it was. No conversation comment and no review is posted, so a reader sees nothing. It needs no GitHub twin; `promote` strips it from the body it sends GitHub, as it strips every staging record, and never rewrites the Forgejo body, so the record survives the first promote and every later one. `pr edit` on a Forgejo pull request keeps it when the new body carries none. `status` reads it back as `selfReview`. Writes nothing to GitHub. | `{"url","reviewedHead"}` |
| `pr answer <pr> --comment <id> --body-file <f> [--resolve]` | Answers one item with `<!-- forgejo-answer: <id>[ resolved] -->`: a review comment as a reply in its own conversation, anything else as a conversation comment. A reply signs in to Forgejo's web as the admin (`POST /user/login` with `admin-password` from the state directory, mode 0600, keeping the last of the two `session` cookies Forgejo sets) and posts `…/{o}/{r}/pulls/{n}/files/reviews/comments` with `reply=<review id>` and the comment's file, line and side, because Forgejo 16's API only opens new reviews. Forgejo then gives the reply the first comment's commit and diff, so it joins that conversation even after a fix commit moved the head. `--resolve` on a review comment then posts `…/{o}/{r}/pulls/resolve_conversation` in the same session, because the API has no resolve route either. Then it re-reads the item and refuses if it is still open. On any other item the `resolved` in the record is the resolution. Writes nothing to GitHub. | `{"answered","resolved"}` |

**Pull requests that stay on Forgejo.** A repository whose git config sets
`throne.forge.pullRequestsStayOnForgejo` to `true` (read with
`git config --type=bool --get throne.forge.pullRequestsStayOnForgejo` in the checkout
`--repo` names; linked worktrees share it) keeps its pull requests only in
Forgejo and never gets a GitHub pull request, review or comment from the
seam. `land` and `pr merge --squash` on a Forgejo pull request there run
one landing, and `promote` does nothing; the order of its steps is in `agent_docs/forgejo.md`,
"Repositories whose pull requests stay on Forgejo". `pr create`, `pr edit` and `pr comment`
whenever they would reach GitHub, and `pr review-findings`, refuse there
with `forge <operation>: <message>`: the message names
`throne.forge.pullRequestsStayOnForgejo`, says the repository's pull requests live only in
Forgejo and land through `throne forge land` (/pr-merge), and
that nothing was sent to GitHub. Their Forgejo branches are unchanged.

| operation | what it does | prints |
| --- | --- | --- |
| `land <forgejo pr>` | Refuses, naming `throne.forge.pullRequestsStayOnForgejo` and ending "Nothing was changed.", in a repository without the key, and refuses a pull request whose base is not the default branch. Fetches `main` from `origin` and the head from Forgejo, runs `git merge --squash` of the head in a scratch worktree of `origin/main` outside the checkout, and commits it with `git commit -S`: the title without `WIP: ` or its `[GH-...]` marker is the subject, and the body's `## What (human)` text, or else its first paragraph, without records or `<details>`/`<summary>` tags, is the body (none when that is empty). A conflict refuses, listing every conflicting path and ending "Nothing was changed.", with nothing pushed or commented. Pushes the commit to `origin` `main`, then to the `forgejo` remote's `main`, never forced. Reads `git ls-remote origin refs/heads/main` back and, unless it names the commit, refuses before commenting or closing, saying GitHub's main does not hold the commit. Comments `Landed on main as <full sha>` on the Forgejo pull request (`POST …/issues/{n}/comments`) and closes it as merged: it turns on the copy's manual merges (`PATCH repos/{o}/{r}` with `{"allow_manual_merge":true}`) and posts Forgejo's manual-merge mark (`POST …/pulls/{n}/merge` with `{"Do":"manually-merged","MergeCommitID":"<sha>"}`), so Forgejo reports `merged: true` with `merge_commit_sha` the landed commit and makes no commit itself; no merge style that makes a commit is ever requested. A refused mark refuses, naming the commit that already landed on both mains and saying the pull request was commented on but not recorded as merged; nothing is pushed again. The scratch worktree is always removed, and the local checkout's working tree and branches are never touched. | `{"forgejoUrl","landedCommit","mirror","base":"main","closed":true}`, `mirror` the `origin` URL |

Exit status: 0 on success; 2 for an unknown operation, flag or missing value
(the usage and an entrance refusal go to stderr); 1 for a refusal (Forgejo not
answering, no token, a Forgejo API error, a failed fetch from `origin`, no
open pull request for a branch, a copied body that still holds a cross-host
media link), and for `check-media-links` when it found a link;
and a GitHub command's own status on the GitHub branch.

## memory-dir

```bash
./bin/throne-cli memory-dir [--json] [--create] DIR
```

Prints the durable cross-session memory directory for the project containing
`DIR` — the place an agent `ls`es before acting and writes a
correction, busted assumption, or dead end to the moment it happens. The throne
never invents a second memory convention when one is already in force, so the
resolution is a precedence, first hit wins:

| mode | detection | printed path |
| --- | --- | --- |
| `in-tree` | `<repoRoot>/agent_docs/MEMORY/` exists (a target repo that keeps memory committed) | that directory, inside the agent's own worktree |
| `project-declared` | root-level `AGENTS.md`, `CLAUDE.md`, or `CLAUDE.local.md` contains one of the strict tokens `memory-dir`, `~/.memories`, `.memories/`, `agent_docs/MEMORY` (prose about "memory" never matches) | the `memory-dir` executable's output when one is on PATH; otherwise the throne-native path plus a stderr WARNING naming `file:line` the agent must read and obey |
| `external` | a `memory-dir` executable on PATH (the operator's own tooling) | its stdout, verbatim |
| `throne-native` | none of the above | `~/.throne/memories/<slug>` |

Every mode keys on the **repository**, resolved through
`git rev-parse --git-common-dir`: a linked worktree and any subdirectory
collapse onto the main checkout, a bare repository is its own identity, and a
directory outside git keys on its own physical path (non-git projects are
real). The slug is that root relative to the physical `$HOME`, with every `/`
turned into `-` (`~/repos/app` is `repos-app`); a root outside `$HOME` keeps
its absolute form, leading `-` included (`/srv/app` is `-srv-app`). Because
every campaign worktree of one target shares the directory, a Shadow's
learning is visible to its siblings the instant it is written —
nothing merges, nothing is lost on reap. The throne itself resolves like any
other repo; it keeps no in-tree memory.

Text mode prints exactly one absolute directory on stdout so
`ls -1 "$(throne memory-dir .)"` composes; `--json` prints
`{mode, path, repoRoot, evidence, warning?}`. Print-only by default —
`--create` is the only thing that `mkdir -p`s, so the bootstrap `ls` never
litters. `DIR` is required and never defaults to the cwd: an agent standing in one
repository while learning something about another must name that other
repository, and a silent cwd default once filed a lesson under the wrong slug
(2026-09-11). Pass `.` when the cwd really is the subject. Exit 2, with
entrance steering, on a missing `DIR`, an unknown flag, a second `DIR`, an
unreadable `DIR`, or an operator tool that printed something other than an
absolute path. A missing `git` degrades to the physical-path rule; it never
fails. `create-agent` runs this resolution from the spawn cwd and writes the
result into the agent's identity, so every spawn is told its memory directory
before its first turn. Resolver: `src/memory-dir/memory-dir-resolver.ts`.

## skill-extension

```bash
./bin/throne-cli skill-extension <skill-name>
./bin/throne-cli skill-extension --list
./bin/throne-cli skill-extension --hook < hook-event.json
```

Prints the operator's own extension to a throne skill: a Markdown file named
for the skill, `<throne home>/skill-extensions/<skill-name>.md`, which is
`~/.throne/skill-extensions/<skill-name>.md` unless `THRONE_DATA_HOME` moves
the throne home. The folder lives outside the repository, so an extension never
ships. With a file, the command prints one line naming it, then its content
verbatim:

```text
$ ./bin/throne-cli skill-extension order-cake
Operator extension for the order-cake skill, from /home/baker/.throne/skill-extensions/order-cake.md:
Before taking the order, check the oven schedule.
```

With no file it prints nothing and exits 0, so a skill can run it
unconditionally. `--list` prints one `<skill-name>: <path>` line per extension,
sorted by skill name, and nothing when there are none. A skill name that is not
a single plain path segment (empty, `.`, `..`, or holding `/` or `\`) is
refused with exit 2 and reads nothing, as is an unknown flag or anything but
exactly one argument. Resolver: `src/shared-policy/skill-extensions.ts`, built
on the throne home resolver; nothing else knows the folder name.

`--hook` is Claude Code's path. `.claude/settings.json` registers it for
`PreToolUse` with matcher `Skill` (a skill the model loads; the event names it
in `tool_input.skill`) and for `UserPromptExpansion` (a typed `/skill`, which
bypasses the Skill tool; the event names it in `command_name`). It reads the
event JSON on stdin and, only when that skill has an extension, prints
`{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}`
with the same text the plain command prints. Anything else (no extension, a
name that is not a plain segment, another tool or event, malformed stdin)
prints nothing and exits 0, and the registered command line always exits 0, so
the hook never blocks a skill or a prompt. It finds the CLI the way the
SessionStart hook does, so it serves the live checkout's build.

## scratch-pane

```bash
./bin/throne-cli scratch-pane register <pane> --owner <agent> --until <ISO-8601 time>
```

Records that a live agent owns an unnamed herdr pane it opened on purpose, such
as a scratch Claude or Codex session for a measurement, until a time. Register
the pane before opening it and close its tab when done. The marker is one JSON
file per pane in `<throne home>/scratch-panes/`, which is
`~/.throne/scratch-panes/` unless `THRONE_DATA_HOME` moves the throne home, so
it never lands in a repository. Registering the same pane again replaces its
marker.

No-idling's unnamed-agent sweep reads the markers. While the owner is a live
agent and the time has not passed, it says nothing about the pane. Once the
time passes it reports the pane to the Regent once as
`expired scratch pane, owner <agent>`; when the owner is no longer a live agent
it reports it once as `orphaned scratch pane, owner <agent>` on the first sweep
that sees it, without the two-sweep confirmation an unregistered pane waits
for. An unnamed pane without a marker is reported as before.

The command refuses, with exit 2 and nothing written, an owner that has no
ledger registration, a time that does not parse or has already passed, an
unknown flag, and a missing pane, owner or time. Source:
`src/scratch-pane/`.

## refresh-stager-tree

```bash
./bin/throne-cli refresh-stager-tree   # prompt-submit hook JSON on stdin
```

Keeps a Stager's own checkout current (`src/stager-tree-refresh/`). It runs
before each prompt through `claude-hooks/stager-tree-refresh.py`, the
`UserPromptSubmit` entry in `claude-hooks/hooks.json`, on Claude and, through
the pi bridge (`extensions/pi/throne-pi-hooks.ts`), on pi. When the tab's
`THRONE_AGENT_NAME` is registered with role `Stager` and the payload's `cwd`
lies inside that Stager's recorded `spawn.json` `cwd`, the checkout is compared
with the local `main` branch (no fetch). Clean and strictly behind:
`git merge --ff-only main`, and one line naming the commit count and new tip
is printed. Dirty (any `git status --porcelain` output, untracked files
included) or diverged (commits of its own that `main` lacks): nothing changes,
and one `WARNING:` line names how many commits it is behind (and, when
diverged, ahead). At or ahead of `main`: silence. Any other session, an
Alpha's or a Shadow's included, is never touched. A failure writes one stderr
line and the command still exits 0, so the prompt is never blocked.

## topic

```bash
./bin/throne-cli topic same|changed <slug>|none [--description "<one line>"]
```

Records a Stager's verdict on whether the Lord's latest prompt changed topic
(`src/topic/`). Only a tab whose `THRONE_AGENT_NAME` is registered with role
`Stager` may run it; any other session is refused with exit 1. `--description`
writes the one-line topic to `~/.throne/data/<stager-name>/topic.md`; `same`
with no saved topic requires it. `changed` never writes `topic.md`, so the
handing-over Stager keeps its own topic; `changed` with `--description` is
refused with exit 2 and records nothing. Every verdict appends one
`{"verdict","slug"?,"at"}` line to
`~/.throne/data/<stager-name>/topic-verdicts.jsonl`; `changed` requires the
new topic's slug.

## recall

```bash
./bin/throne-cli recall [--session ID] (--directory DIR | --memory-dir DIR)... [--no-global] [--json] "<task text>"
./bin/throne-cli recall --status
./bin/throne-cli recall --report [--since DATE]
./bin/throne-cli recall --spot-check [--count N]
./bin/throne-cli recall --agree ID ["<reason>"]
./bin/throne-cli recall --disagree ID "<reason>"
./bin/throne-cli recall --lint-asks [--directory DIR]... [--global]
```

Prints the BODIES (never paths: every extra file read re-reads the whole
context) of the recorded memories that apply to the task, most relevant first,
capped at `recall.maximumInjectedCharacters`. A hand call names its scope:
`--directory DIR` (a repository or any path inside it; its memory directory is
resolved like `memory-dir`) and `--memory-dir DIR` (a memory directory,
searched as given) are both repeatable and may be combined, so one call covers
several repositories. With neither, recall refuses with exit 2, naming both
flags and the current directory it would otherwise have assumed; a
`--directory` whose memory directory cannot be resolved is refused, never
dropped. Candidates are every `*.md` (except `MEMORY.md`, `README.md` and `REPOSITORY.md`) in
those memory directories and in `recall.globalMemoryDirectories`, which
`--no-global` leaves out. Code drops a memory whose frontmatter says
`status: superseded` or names another project's `scope` before any question is
asked. Each remaining memory becomes one yes/no question (its `ask` line, or
one made from its file name), answered by the keyword rules, and a probability at or above the threshold serves the memory.
`--session ID` keeps a served list under `~/.throne/data/recall/served/`
(each served memory with the time it was served) so nothing is printed twice
in one session (lists older than 30 days are removed). Decisions are appended
to `~/.throne/data/recall/ledger.jsonl` under one summary line per recall. An
answer whose probability of yes is at least 0.1, or that was served or failed
open, gets a full line (question id, input hash, pick, probability, backend,
failed open, `reason` (the classifier failure, when there was one), served, arm, session, and the sha256
`contentHash` of the memory text that was judged). A confident no (below 0.1)
gets a compact line of five keys (`at`, `inputHash`, `questionId`, `pick`, `probability`), and that
recall's summary carries `everyAnswerLogged: true`, so a memory with no line
there was never a candidate. A ledger over 20 MB is set aside as
`ledger.previous.jsonl`. The task text itself is never written there. Every
memory version the ledger names is copied once to
`~/.throne/data/recall/memory-versions/<sha256>`, so a later edit of the file
cannot change what a spot check grades. A memory worth serving that is withheld
because the session already saw it gets `suppressed: true` and
`servedEarlierAt` (the earlier prompt's time, `null` when the served list
predates serving times) on its decision line; it still counts toward the
verdict.

Every ledger summary records the source, session, arm, the verdict ("memory
likely exists" or "no relevant memory") with its confidence, and the scope as
`searchedMemoryDirectories` (absolute memory directory paths in search order).
Lines with `source: "hook"` were written by the prompt-submit recall hook,
which has been removed. Memories already
served in the session are still asked about, so they count toward the verdict,
but are never served again. Whatever recall prints carries the scope on its own line: each
searched repository's path and its memory directory, or the memory directory
named by hand, and the global directories or that they were left out, followed
by a sentence saying that another repository's memories need
`throne recall --directory <path> "<task>"` (left out when an other-repositories
directive was printed). A verdict line saying that a relevant memory likely exists, or that there is no relevant
memory, in the scope it names (never an unqualified "no relevant memory")
follows the served memories, and is printed alone only above
`recall.verdictLineThreshold`. It opens with `rules`.

A memory the rules answered yes to that is not served is named on
stderr with its reason: `below the serving floor` (a yes under probability
0.4) or `over the size limit` (it did not fit under
`recall.maximumInjectedCharacters`). A memory already served in the session is
not named there.

### Other repositories

Every recall also tells the agent to search
each other repository the classifier rates likely to hold a relevant memory (at most
three), with a runnable command carrying the task, so an agent whose lookup
came back thin knows where to look next. They are never searched here.

- **The registry.** Every repository a recall searches (each `--directory`) is saved in
  `~/.throne/data/recall/repositories.json` with its checkout (the main
  checkout for a worktree), repository name, memory directory and `lastSeenAt`.
  When the file does not exist yet, it is seeded once from the memory
  directories under `~/.memories/` whose slug spells an existing checkout
  (seeded entries carry `lastSeenAt: null`). A later recall of the same
  checkout replaces its entry.
- **The candidates.** Every registry repository that is not already in the
  lookup's scope (by checkout, or by a memory directory it already searches)
  and whose memory directory holds at least one memory.
- **The question.** One yes/no question per candidate rides in the same
  classifier call as the memory questions: the repository's name,
  the `ask:` from an optional `REPOSITORY.md` in its memory directory
  (frontmatter in the house form `--lint-asks` enforces; never served as a
  memory), and the titles of its memory files, most recently modified first,
  at most `recall.repositoryMemoryNamesPerRepository` (default 40). Names only,
  never bodies.
- **The directive.** The candidates whose probability of yes is at least the
  serving floor (0.4, the bar a memory needs to be served; a failed-open answer
  never counts), at most three, most likely first, ties in name order, printed
  after the verdict line. The command carries the task: its first non-blank
  line, trimmed, cut to 120 characters and shell-quoted (the literal `"<task>"`
  only when the task has no text). Candidates below the floor are not printed,
  and with none above it there is no block at all:

  ```
  bakery-site probably holds memories for this task (88%). Search it before looking it up yourself:
  throne recall --directory /home/me/repos/bakery-site 'fix the oven timer'
  ```

  Two or three shown read `florist (58%) and bakery-site (44%) probably hold
  memories for this task. Search them before looking them up yourself:`, then
  one command line each in the same order.

  The keyword rules rate no repository, so nothing is listed and the block
  says so in one line.
- **The records.** Every repository answer gets a ledger line beside the
  memory answers: `at`, `inputHash`, `otherRepository` (the checkout),
  `repositoryName`, `memoryDirectory`, `memoryNamesAsked`, `pick`,
  `probability`, `backend`, `failedOpen`, `reason` when the classifier failed,
  `rank` (1 is most likely), `listed` (shown as a directive by this lookup), `arm` and `sessionId`.

`--json` (refused with exit 2 next to `--status` or `--report`) prints one object instead of the text:

```json
{
  "scope": { "repositories": ["/home/me/repos/florist"], "globalMemoryDirectories": ["..."] },
  "verdict": { "memoryLikelyExists": true, "confidence": 0.89, "backend": "rules" },
  "memories": [{ "file": "...", "probability": 0.73, "served": true, "body": "..." }],
  "withheldMemories": [{ "file": "...", "probability": 0.39, "reason": "below the serving floor" }],
  "otherRepositories": [
    { "repository": "...", "checkout": "...", "memoryDirectory": "...", "probability": 0.88,
      "recall": "throne recall --directory ... 'fix the oven timer'" }
  ]
}
```

`memories` holds what was served; `withheldMemories` holds every yes that was
not, with the same two reasons as the stderr line; `otherRepositories` holds
only the repositories shown as a directive, each `recall` carrying the task. `scope.repositories` lists the `--directory`
paths only.

Before working in another repository, run
`throne recall --directory <that repo> "<task>"` instead of grepping its memory
directory by hand.

Config: `docs/CONFIG.md`, "recall". Engine:
`src/memory-recall/`, classifier contract: `src/relevance-classifier/`.

### What the memory-read log sees

Digs are recorded by the memory read log hook (see
`ensure-harness-setup`), which records every hand read or search of a memory
directory. A Grep, or a Bash `grep`, `rg` or `find`, over memory counts as
having found each memory file its output named, graded like a full read even
if the file was never opened; a search of one file, whose output names no
file, counts that file when it printed anything. Each named memory is recorded
with its sha256 in `memoryFileHashes` and copied to the same `memory-versions/`
store. A read from a directory that names no throne agent takes its agent name
from the herdr pane (`herdrPaneId` is on every line). Reads made inside a
Claude Code subagent (the Agent tool) are logged: a live test on 2026-09-28
had a subagent Read a memory file, and the line landed in
`memory-reads.jsonl` under the parent session's `sessionId`, the parent's
agent name and the parent's `transcriptPath`, so a subagent's read counts as
the parent's own. A tool call that fails, such as a Read of a path that does
not exist, fires no hook and logs nothing. A memory read through a shell
variable that is not an environment variable (`cat "$DIR/X.md"` after
`DIR=...` in the same command) is not logged, because the hook cannot expand
it. The read hook is a Claude Code hook; sessions on any other
harness are not measured at all.

### `--report`

`--report [--since DATE]` prints one line saying the prompt-submit recall hook
was removed and there is nothing more to report, and exits 0. `--since` is
still checked (an ISO date or date-time; anything else is refused with exit 2).

### `--lint-asks`

`--lint-asks [--directory DIR]... [--global]` checks every memory's `ask`
against the rules for an ask recall can find, in pure code: it calls no
classifier, not even the keyword rules, and never edits a file. With no flag it reads every memory directory directly under
`~/.memories/`; `--directory DIR` (repeatable, a repository or any path inside
it) reads that repository's memory directory, resolved as in a hand recall and
refused with exit 2 when it cannot be; `--global` adds
`recall.globalMemoryDirectories`. Task text or any other flag is refused with
exit 2. It reads
every `*.md` but `MEMORY.md`, `README.md` and `REPOSITORY.md` and skips
`status: superseded`, then checks the `ask:` of each directory's
`REPOSITORY.md`, when there is one, by the same rules except the bare
repository name rule (a repository ask names its repository on purpose); a
`REPOSITORY.md` with no ask is flagged `missing-ask`.

Each violation is one stdout line, `<memory file path>\t<rule>\t<ask>` (the
ask is `(no ask)` when there is none), sorted by path and then in the rule
order below. Stderr gets one summary line:
`recall --lint-asks: N violations; F of M memories flagged; D memory
directories read`. The exit code is 0 with no violation and 1 with any.

An ask passes in the house form `Does the task touch <area> in any way?`
(`Does the task involve <area>?` and `Is the task about <area>?` are accepted
too), where the area is what the lesson is about as the memory names it. The
rules, each named after the lesson that taught it:

| Rule | Flags | Lesson |
| --- | --- | --- |
| `missing-ask` | no `ask`, or an empty one | |
| `bare-narrow-ask` | a first sentence in none of the house forms, such as one that asks whether the task will run, open, edit or debug the subject | |
| `kept-narrow-trigger` | text after the first sentence that does not start with `That includes, but is not limited to:` | |
| `token-area` | an area that is or holds a code token: backticked text, a path, a file name with an extension, a flag, a command line, a camelCase or snake_case identifier, a word mixing letters and digits, a version, or a single all-capitals word as the whole area | `THE_TOKEN_GATE_ON_AREA_PICKS_STILL_PASSES_GENERIC_NOUNS_FRAGMENTS_AND_POSSESSIVE_CODE_NAMES` |
| `bare-repository-name` | an area that is only the name of the repository the memory directory belongs to, alone or followed by repo, repository or codebase | `THE_BARE_REPOSITORY_NAME_IS_NO_AREA_FOR_A_MEMORY_IN_THAT_REPOSITORYS_DIRECTORY` |
| `repository-wide-noun` | an area whose head noun (the last word before a preposition, for each part joined by and, or or a comma) is repository, repo, branch, commit, PR, pull request, worktree, agent, Alpha, Shadow, Stager, Regent, campaign, slice, row, trunk or main | |
| `verb-ending-fragment` | an area that ends on a verb: one of a closed list (needs, picks, refuses, fails ...) or any word after a modal, an auxiliary or a negation | `VERB_ENDING_FRAGMENTS_WITHOUT_AN_AUXILIARY_PASS_BOTH_AREA_GATES_UNLESS_THE_TOKEN_QUESTION_NAMES_THEM` |
| `general-computing-term` | an area that, leading article dropped, is wholly a general computing term from a closed list (env vars, file paths, test fixtures, markdown, JSON ...); a qualified area such as "the shop's config" passes | |

The area rules judge only an ask in a house form. The repository name comes
from walking the file system along the memory directory's slug to the
checkout it names; a directory whose slug names no checkout on this machine,
and every global directory, skip `bare-repository-name`. The memory read log
hook does not log a `recall --lint-asks` call. Rules:
`src/memory-recall/ask-lint-rules.ts`; command: `src/memory-recall/ask-lint.ts`.

### `--spot-check`, `--agree`, `--disagree`

`--spot-check [--count N]` prints N (default 10) prompts chosen at random from
those the judge has graded: an id, the time, arm and kind, the first 300
characters of the prompt, what recall served or would have served, what the dig
found, and every grade the judge gave. `--agree ID ["<reason>"]` and
`--disagree ID "<reason>"` (the reason is required) append
`{at, id, verdict, reason}` to `~/.throne/data/recall/spot-checks.jsonl`; an
unknown id is refused with exit 2. Each of the three flags goes alone, and
`--count` only with `--spot-check`. Every verdict counts, repeats included.

## rank

```bash
./bin/throne-cli rank "<yes/no question>" [--top N] [--min PROBABILITY] [--json] <files or globs...>
<items> | ./bin/throne-cli rank "<yes/no question>"
./bin/throne-cli rank --status
```

Ranks files, or stdin items (one per line, or JSON lines of
`{"id": "...", "text": "..."}`), by how likely each answers yes to the
question, and prints one line per item, most likely first: the probability,
then the path or id. Item contents are NEVER printed. One yes/no question per
item; small items share a request as named state fields, a large file is its
own request, and one over the state limit is split and scores as its best
piece. The ranking is word matching (the share of the question's meaningful
words the item contains), done on this machine. FAIL OPEN
here means: on any error every item is printed, unranked (`-`), with one
stderr line; an item never vanishes because a call failed. A ranking is a hint
about where to look, never proof that something is absent. The ledger gets the
item id, a hash and the probability, never contents or the question.
`--status` on `recall`, `sift` and `rank` prints that the keyword rules
answer.

## locate

```bash
./bin/throne-cli locate "<task description>" --root <repo> [--root <repo>...] [--top N] [--min PROBABILITY] [--budget N] [--json]
./bin/throne-cli locate --status
```

Finds which files in one or more repos are likely to answer a task, before
you start opening them by hand. Gathers candidate files under each `--root`,
then scores each against the task the same way `rank` scores items, and
prints a ranked list, most likely first: path, probability, and a short
reason (`path  p=0.87  matches:revoke path:widget-store history:revokeWidgetStoreAccessForUser`).
`--budget N` caps how many gathered candidates are sent into scoring, keeping
cost bounded on large repos; `--top`/`--min`/`--json` behave as in `rank`.
`--status` must appear alone and prints the resolved classifier backend, the
same as `rank --status`. Every successful non-`--status` call appends a
decision record to the shared ledger.

## sift

```bash
<command> 2>&1 | ./bin/throne-cli sift "<what I am looking for>"
```

Saves the full input to `~/tmp/sift-<time>-<pid>.log`, splits it into
40-line chunks that share 5 lines with their neighbour, asks keep or drop per
chunk, and prints the kept lines with their original line numbers (`...`
marks a gap), then one line: how many lines were dropped and where the full
copy is. The last chunk is always kept. Unsure means keep: any error or a probability under
`recall.siftKeepThreshold` keeps the chunk, and an unloadable config prints
everything. The rules keep a chunk that contains a word of the query or a
common failure word (`error`, `fail`, `not ok`, `exception`, `panic`,
`traceback`).

## ensure-heartbeat

```bash
./bin/throne-cli ensure-heartbeat
```

Idempotently arms the keep-going timer — renders
`systemd/throne-keep-going.{service,timer}` into the systemd user unit dir
(`$XDG_CONFIG_HOME/systemd/user`, falling back to `~/.config/systemd/user`) as
real files through the shared install core in `serviceunits.ts`,
`daemon-reload`s, and `enable --now`s
`throne-keep-going.timer` — so no operator ever runs `systemctl --user enable
--now` by hand. Fast-paths to a no-op when the timer is already active; degrades
gracefully (prints one line, exits 0) when `systemctl --user` is unreachable (no
systemd, no user bus). Only returns non-zero when systemd IS reachable but a
step genuinely fails. Also the reusable core `throne-startup` calls on every
harness launch.

## install-services

```bash
./bin/throne-cli install-services [--dry-run] [--throne-root <absolute path>]
```

Installs the throne's hooks and services for the current user, together with
the owned pinned herdr client, the public attach seam, and the isolated
named-session herdr service.

Linux installs and enables `throne-backend.service`, `ntfy.service` and the
three `sweep-tmp-scratch-*` timer pairs (for `/tmp`, `/tmp/claude-1000` and `~/tmp`; `~/tmp` is a cache whose top-level entries are deleted oldest first only while its disk has under 100 GB free, and only when more than 30 days old, so long-lived caches go under `~/.throne/cache/<tool>/`) and `throne-herdr.service`; these are rendered into
`$XDG_CONFIG_HOME/systemd/user` (fallback `~/.config/systemd/user`). macOS
installs and bootstraps `com.throne.throne-backend`, `com.throne.ntfy` and
`com.throne.throne-herdr` in `~/Library/LaunchAgents`. The sweep timers have no mac counterpart: the
`/tmp` pairs exist for a tmpfs inode cap macOS does not impose. The ntfy unit on both
platforms runs `systemd/ntfy-serve`, which starts the pinned
`binwiederhier/ntfy` image under docker or podman — `./install.sh` pulls it;
`install-services` itself never touches a container runtime.

Both platforms also register every throne Claude Code hook in the
user-level `~/.claude/settings.json`. The hooks are listed once, in
`claude-hooks/hooks.json`, and one installer
(`src/install-services/claude-hooks.ts`) registers every entry whose `notOn`
does not name `claude`. Each entry has `script` (a file in `claude-hooks/`),
`event` (the Claude Code event), `matcher` (the tool pattern, absent when the
event has none), and optionally `notOn` (harness names that must not run it,
such as `["pi"]`), `timeout`, `statusMessage`, `replaces` (patterns of retired
script commands the entry supersedes) and `withGlobalMemoryDirectories`. The
pi bridge `extensions/pi/throne-pi-hooks.ts` runs the same list on pi agents
(`extensions/pi/AGENTS.md`), and the launchers' hook check reads it too.

To add a hook, write one script in `claude-hooks/` and add one entry to
`claude-hooks/hooks.json`; the next `install-services` or launch registers it
for Claude Code and pi runs it, unless `notOn` names that harness. No
installer or launcher file changes.

The guard, `claude-hooks/scratch-path-guard.py`, is a `PreToolUse` entry with
matcher `Bash`. The hook refuses a Bash command
that writes, moves, copies into or removes a path under `/tmp` or
`/private/tmp` (the harness scratchpad `/private/tmp/claude-<uid>/` included),
or a single-segment path at the filesystem root such as `/tmp_lintout.txt`, and
a removal that spells the home directory as `~` or `$HOME`. Its refusal names
the literal home `tmp` directory, resolved at run time, as the place for
scratch files. The reason: Claude Code prompts for any removal at the
filesystem root, of a critical path, or of an unresolvable home path even with
permissions bypassed, and an unattended pane stalls on that prompt; the home
`tmp` directory also survives a reboot and has no per-user tmpfs quota. It
also refuses an `rm` or `rmdir` whose path uses a shell variable not written as
`${NAME:?}` (`$D`, `${D}`, `${D:-x}`, `$1`, ...), naming the variables and
handing back the whole command with each of them rewritten as `${NAME:?}`:
Claude Code stops a removal whose path could collapse when a variable is empty,
even with permissions bypassed, and `${NAME:?}` stops the command instead. A
home-directory variable keeps the literal-home guidance, and command
substitution such as `$(pwd)` is not checked. Reads
of `/tmp` pass, and heredoc bodies and single-quoted text are ignored. The
registration is idempotent (reported as `registered`, `replaced` or
`unchanged`); an entry for the older standalone `rm-literal-home-guard.py`, or
for another checkout's copy, is replaced so only one guard runs, and a
`settings.json` that is not a JSON object is left untouched and fails the run.
`./uninstall.sh` removes the entry. The hook's own tests live beside it
(`claude-hooks/test_scratch_path_guard.py`) and run under `bun run test` through
`test/claude-guard-hook.test.ts`.

The same install pass also registers `claude-hooks/skill-write-guard.py`, the
companion enforcement hook for the `/skill-writer` skill, in
`~/.claude/settings.json` as a `PostToolUse` entry with matcher `Edit|Write`. It fires on any write,
edit, port, move, or copy of a `SKILL.md` file and reminds the writer to run
`/skill-writer`. Registration appends into the same matcher's `hooks` array
alongside any hooks already registered there, creating the matcher entry only if
genuinely absent, and is idempotent the same way the guard hook above is: a
stale prior registration for this hook file is replaced in place, and a
second run reports `unchanged`. Its own tests live beside it
(`claude-hooks/test_skill_write_guard.py`) and run under `bun run test` through
`test/skill-write-guard-hook.test.ts`.

`claude-hooks/hidden-skill-pointer.py` tells an agent where a skill hidden
from its listing lives. A skill is hidden when its `skillOverrides` value is
`user-invocable-only` or `name-only` in `~/.claude/settings.json` or the
project's `.claude/settings.json` / `.claude/settings.local.json` (the project
wins for the same name); `off` and `on` get nothing. When a hidden name is met
as a whole `/<name>` (not `/<name>-more`, not a path segment), the hook adds one
line naming the first existing `SKILL.md` among the working folder's
`.claude/skills/<name>/`, the main checkout's (from a worktree), and
`~/.claude/skills/<name>/`, and says to read it and follow it. It reads a prompt
(`UserPromptSubmit`), a `Skill` call's name (`PreToolUse`, the call goes
through untouched), and the content of a file the agent `Read`s, only when that
file is a `.md` in a `skills/<name>/` folder, a `CLAUDE.md` or `AGENTS.md`, a
`.md` under `agent_docs/`, or a `.md` under the throne data home
(`THRONE_DATA_HOME`, default `~/.throne`); a skill's own `SKILL.md` never points
at itself. On Claude Code 2.1.322 a `Skill` call naming a hidden or unknown
skill is refused before any hook runs, with no `PreToolUse`, `PostToolUse` or
`PostToolUseFailure` event, so the prompt and file-read triggers do the work
and nothing waits on the tool's refusal. Each skill is pointed at once per
session (recorded under `${XDG_CACHE_HOME:-~/.cache}/throne/hidden-skill-pointer/`).
Any error, or settings with no hidden skill, prints nothing and exits 0; a run
with no hidden skill takes about 40 ms. Its tests live beside it
(`claude-hooks/test_hidden_skill_pointer.py`) and run under `bun run test` through
`test/claude-guard-hook.test.ts`.

`claude-hooks/web-fetch-failure-pointer.py` tells an agent whose web fetch
failed to try `agent-browser`, which drives a real browser and often gets past
a bot wall. It prints the literal `agent-browser open <address>` and, for a site
that still refuses, the same command with `--user-agent "<desktop Chrome
identity>"` filled in, plus the agent-browser skill's path when one exists
(working folder, main checkout, then `~/.claude/skills/`). On Claude Code
2.1.322 a WebFetch answered with an HTTP error arrives as `PostToolUse` with
`tool_response.code` (403 from https://blocked.example.com/), a WebFetch that
cannot connect arrives as `PostToolUseFailure` with `error`, a `curl`/`wget`
that exits non-zero arrives as `PostToolUseFailure` with `error: "Exit code
N..."`, and a `curl -w "%{http_code}"` that exits 0 arrives as `PostToolUse`
with the status in `tool_response.stdout`; so the hook is registered on both
events for `WebFetch` and `Bash`. It advises on 401, 403, 429 and 5xx, never
on localhost, loopback, private ranges or `*.ts.net`, only when `agent-browser
--version` runs from the agent's working folder within 2 seconds (the answer is
cached for the session, since a mise shim can be on PATH yet fail for the
folder's node version), and once per address per session (recorded under
`${XDG_CACHE_HOME:-~/.cache}/throne/web-fetch-failure-pointer/`). It only adds
context: it never blocks, never rewrites a call, and any error of its own
prints nothing and exits 0. Its tests live beside it
(`claude-hooks/test_web_fetch_failure_pointer.py`) and run under `bun run test`
through `test/claude-guard-hook.test.ts`.

Both platforms also turn off herdr's own agent resume: the herdr config
(`HERDR_CONFIG_PATH`, else `$XDG_CONFIG_HOME/herdr/config.toml`, else
`~/.config/herdr/config.toml`) gets `[session] resume_agents_on_restore =
false`, every other line kept, so a restored pane comes back as a shell that
startup reconciliation relaunches on the pinned harness
(`src/install-services/pinned-harness-on-restore.ts`).

The same pass writes `<throne root>/shell/throne-session.bash` and adds the
throne shell block, one line between two marker comments, to the end of
`~/.bashrc`, writing through the file when `~/.bashrc` is a symlink. The
line sources the session file only when `HERDR_SESSION=throne`, so a shell in
the throne herdr session gets the throne `bin/` first on `PATH` and
`CLAUDE_BIN`/`CODEX_BIN` on the vendored harnesses. Each of the three writes
reports `unchanged`, or `would …` under `--dry-run`, and none restarts herdr.

## ensure-harness-setup

```bash
./bin/throne-cli ensure-harness-setup [--throne-root <absolute path>]
```

Re-registers only the harness hooks: every Claude hook in
`claude-hooks/hooks.json` (above), and the Codex `SessionStart` hook in
`.codex/hooks.json`, through the same functions `install-services`
calls. It renders no service unit and restarts nothing.

It prints one line per hook, `unchanged`, `added`, or `failed: <reason>`, and
on any failure exits 1 and sends the Lord an ntfy message. Without
`--throne-root` it registers the running checkout, and refuses when that is
a linked worktree.

Three callers run it:

- `bin/claudey` and `bin/codexy`, before the harness starts
  (`throne_launch_check` in `bin/agent-launcher-lib.sh`). A shell check greps
  `~/.claude/settings.json` for every script `claude-hooks/hooks.json` does
  not keep off `claude`, and `.codex/hooks.json`, for the launcher's own
  root first, and reports any listed script missing from the checkout, so a healthy launch starts no node process; only a gap runs the
  command, with `--throne-root` set to the launcher's `bin/` parent. A failed
  repair never stops the launch. The check is skipped when that root is a
  linked worktree. The same check reports a `~/.claude/skills` link that
  resolves to nothing and every `global` entry of
  `.claude/skill-dependencies.tsv` missing under `~/.claude/skills`; it
  never creates or edits either.
- `throne-backend`, once on startup, when it runs from the live checkout.

The memory read log hook, `claude-hooks/memory-read-log.py`, is a
`PostToolUse` entry with matcher `Read|Grep|Glob|Bash`. It appends one JSON line to `~/.throne/data/recall/memory-reads.jsonl`
whenever an agent reads memory by hand: a Read, Grep or Glob inside a memory
directory, a Bash `cat`, `head`, `tail`, `sed`, `less`, `grep`, `rg`, `ls` or
`find` against one, or any `throne recall` but `recall --lint-asks`, `rank`
or `sift`. Memory
directories are `~/.memories/`, `~/.throne/memories/`,
`~/.claude/projects/*/memory/`, any `agent_docs/MEMORY/`, and each
`recall.globalMemoryDirectories` entry, which the registration passes to the
hook as arguments, so a changed list replaces the entry on the next launch and
an unreadable config registers it with none. Each line carries `at`,
`sessionId`, `agentName`, `tool`, `kind` (`read`, `search`, `list`,
`recall-command`), `target`, `memoryFiles`, `returnedSomething`, `readInFull`,
`transcriptPath`, `cwd`, `herdrPaneId`, `memoryFileHashes` (sha256 of each named
memory file, whose text is copied to `~/.throne/data/recall/memory-versions/`)
and, for a `throne recall` call, `recallArguments`. A search records only the
memory files its output named. When the working directory names no throne
agent, the agent name comes from `herdr agent list` for the hook's pane, the
one process the hook starts, bounded at one second. The hook always exits 0
with no output and appends `{"at", "error"}` to `memory-reads.failures.jsonl` when it
cannot write a line. Its tests are `test/memory-read-log-hook.test.ts`.

`.claude/skill-dependencies.tsv` records every skill that `AGENTS.md` or a
shipped `SKILL.md` names, as `shipped`, `global`, `harness`, `generated`, or
`not-a-skill`;
`test/every-skill-a-throne-skill-names-is-in-the-dependency-manifest.test.ts`
fails on a named skill it does not record.

Before rendering, each platform retires whatever pre-consolidation unit is
still on the box — `herdr-server`, `throne-keep-going`, `throne-no-idling`,
`throne-work` and `throne-build` on linux (`RETIRED_LINUX_UNITS`: stop,
disable, remove the file), `com.throne.{herdr-server,keep-going,no-idling}` on
mac (`RETIRED_DARWIN_AGENTS`: `launchctl bootout`, remove the plist; never
`launchctl disable`, which would persist and block a future bootstrap). Their
sources are deleted from the repo.

Sources under `systemd/` and `launchd/` carry `{{THRONE_ROOT}}`,
`{{HERDR_BIN}}` and/or `{{NODE_BIN}}`; the command substitutes whichever
tokens are present and refuses to install any rendered file that still
contains a token. Installed artifacts are real files, so a pre-existing
symlink is replaced and reported. Re-running writes no file and issues no
MUTATING service-manager command — it still probes each unit's state first
(`is-active`/`is-enabled` on linux, `launchctl print` on mac) to decide.

Changing the flag itself never touches or restarts a live server and never
performs a service-manager operation. The
installer never restarts, stops or kills anything on linux, and never boots out,
kickstarts or kills anything on mac. When an installed unit's content changes
while that unit is running, it reports that and leaves the running service
alone — applying the new content is left to an operator, and for herdr-server
that means an explicit handoff or a planned restart between agent runs, which
still drops every live agent pane.

On both platforms it also renders the Codex SessionStart hook registration:
the committed, token-bearing `.codex/hooks.json.template` becomes the
gitignored `.codex/hooks.json` inside the checkout whose code is running —
Codex reads that file in place (and trust-gates it by content hash), so it is
a checkout-local artifact rather than a service-manager unit. The same rules
apply: leftover tokens are refused, identical content writes nothing, and it
renders even where the platform's service manager is unreachable.

`--dry-run` prints the full plan (files and service-manager argv) and mutates
nothing. `--throne-root` sets only the absolute path substituted INTO the
rendered units and hook; sources are always read from the checkout whose code
is running, which is how a worktree installs units that point at the live
throne.

Linux is proven live on the court's own box. The mac branch was first run
against a real launchd on 2026-09-02 (macOS 26 / Darwin 25.6): the plists
parse, and `launchctl print` / `enable` / `bootstrap` / `bootout` behave as
`src/install-services/darwin.ts` expects; `src/install-services/darwin.spec.ts`
covers the retirement, bootstrap and idempotence branches with fakes. A mac
has no journal: both live agents append to `~/.throne/logs/` (AGENTS.md
"Where the throne keeps things").

The separate five-minute `alpha-autoscale` hosted tick touches Alphas and
Shadows only (the env switch `THRONE_ALPHA_AUTOSCALE_ENABLED=1` is permanently
armed in both service templates since 2026-09-02; the operator pause is
`steering.autoscaleEnabled: false` in the live `config.user.ts`, flipped by
the `/autoscaler` skill and re-read by the worker every tick). The live Stager
floor belongs to the backend's every-minute `court-liveness` worker, which
also runs once at backend start. While desired state is `running` and the
Regent is live, zero positively-known live Stagers is an immediate breach with
no grace tick, cooldown, capacity hold, or autoscale kill-switch exemption:
the worker brings back the newest registered dead Stager under its own name,
worktree and session, and only when none can be reused creates one through
ordinary `spawn-git-tree` and `create-agent --role Stager`. A live Stager
makes the effect idempotent. Unknown role/roster evidence or multiple live
candidates fails closed. `dismissed` is the sole exemption and logs
`STAY DOWN` without creating anything.

```bash
./bin/throne-cli alpha-autoscale-tick
```

Runs one published autoscale watchdog tick through the hosted worker's same
`runOnce()` path. It exists for bounded operational checks where waiting for the
five-minute cron would obscure which generation acted; it does not call the
Stager decision helper or either spawn primitive directly.

`alpha-autoscale-tick` and its alias `autoscale-now` run that
sweep inside `throne-backend` over REST by default, so a manual poke shares the
cron tick's process, its in-process gate and its lock. A REST failure exits
non-zero naming `--local`; it never falls back on its own. `--local` runs the
sweep in the calling process and takes the same lock.

`--bypass` runs one sweep past the pressure gate (Lord, 2026-10-28: "geee
throne autoscale-now needs a --bypass flag"): the pressure verdict is treated
as `take-more-work` for that run, the log names the verdict and figure it
overrode, and the run launches at most one Alpha. Every other refusal stays:
the kill switch, cooldown, the ready queue, the launch ledger, the Alpha
ceiling, dependencies and target overlap.

Every sweep, from every entry, first takes the cross-process lock
`<data home>/locks/alpha-autoscale.lock` inside `runOnce()`. A sweep that finds
it held does not wait: it logs one `skip: another alpha-autoscale sweep holds
...` line naming the holder's pid and how long ago it renewed, sends no
floor-breach page, and exits 0. The lock expires 60 seconds after its last
renewal; the holder renews every 20 seconds and stops renewing 10 minutes after
acquiring it, so it is free at most 60 seconds after its holder dies or hangs
and never later than 11 minutes after it was taken.

## autoscale-status

```bash
./bin/throne-cli autoscale-status          # human-readable
./bin/throne-cli autoscale-status --json   # the same report for machines
```

Shows the autoscaler's current state and what its next run would do, and
changes nothing: it spawns, promotes, briefs and writes nothing, never takes the
sweep lock or waits behind a running sweep, and never advances the in-memory
floor-breach timer. Any role may run it. `autoscale-now` is the command that
acts; this one only reads.

It runs inside `throne-backend` over REST by default (the `autoscale-status`
route), because the kill switch is the backend's environment variable and the
breach duration lives in the backend's memory. If the backend cannot be
reached it reads in the calling shell instead, exits 0, and prints this first
line: `backend unreachable — kill switch and breach duration are this shell's
view and may differ from the backend's`. `--local` reads in the calling shell
too and prints the same line.

The report has seven sections, in this order:

1. Autoscaler: running or paused, naming the pause (`steering.autoscaleEnabled`
   in `config.user.ts` with its reason, or the kill switch
   `THRONE_ALPHA_AUTOSCALE_ENABLED=0`), and whether a sweep holds the lock now.
2. Next scheduled run: the time until the backend's five-minute cron job fires,
   read from its schedule; from a shell, `every 5 minutes, next time unknown`.
3. Slots: free slots (capacity minus live Alphas), the capacity, the live-Alpha
   floor and whether it is breached and for how long, and each live Alpha with
   its queue objective.
4. Machine pressure: the verdict, the value, the launch budget, and whether it
   holds spawns.
5. Spawn cooldown: elapsed, or the limiter's own reason it is not.
6. Queue: launchable rows in the order the next run would take them (objective,
   priority, Alpha name, target repository and branch, model hint, single-slice);
   open rows that are not launchable and why; deferred rows, each
   listed as held until the Regent runs `release-deferred`, with what it waits
   on, its defer reason, and since when it has been deferred (time and whole
   hours); in-flight rows with their Alpha; which rows the next run would brief
   or recover (only agentless in-flight rows are ever recovered); and the
   repositories being changed now. A deferred row is never shown as about to
   release or launch: the autoscaler never starts one.
7. Next run: `would spawn <code> as <alpha>` or `would skip: <reason>`, where the
   reason is the line the sweep itself would log. It is a prediction computed by
   the sweep's own decision over the queue as the next run will see it after its
   briefing and recovery steps, and pressure or the queue can change it before
   the tick.

## agent-settings-tick

```bash
./bin/throne-cli agent-settings-tick             # check every agent once, now
./bin/throne-cli agent-settings-tick --dry-run   # print what would change, change nothing
```

Runs one tick of the agent settings check, the same tick the backend's
`agent-settings` hosted worker (`src/agent-settings/agent-settings.hosted-worker.ts`)
runs every minute. The check keeps every agent's pane telling the truth
about who it is: each kind of agent has one colour, and a Claude Code session
carries the same name as its herdr tab. The tab name is the truth. The check
never renames or recolours a herdr tab; it only corrects the harness inside it.

Each tick reads the status roster once and prints one line per agent that is
not reaped:

- A live Claude Code agent is compared with what it should be. Its colour and
  session name are read from its session transcript, never by typing into the
  pane. What differs is corrected with the harness's own `/color <name>` and
  `/rename <name>`. When the agent's `spawn.json` records `delivery_socket` and its
  `GET /alive` answer says `commands: true`, the command goes to the mod as
  `POST /deliver` with `{ id, pane, command, args, waitMs }` and the mod runs
  it without a turn; no pane is read and no key is sent. A `delivered` answer
  is applied, a `busy` one is
  `skipped-busy`, and any other answer is logged and typed once. Otherwise the
  command is typed into the pane, and only when the agent is idle and its
  textbox is recognised, empty and free of any dialog; if not, the line says
  `skipped-busy` and the next tick tries again. The correction right after a
  spawn skips its wait for a ready pane when the mod takes commands.
- A live agent on another harness is reported and nothing is typed.
- A tab whose name matches no recorded agent is reported and left as it is.
- A dead agent whose tab still exists, with one pane and no live harness in
  it, has its harness brought back in that same pane, resuming its recorded
  session and keeping its name. Colour and name follow on a later tick. An
  agent with no tab is left alone and no tab is ever opened. The Regent and
  the Stager that `court-liveness` keeps alive are left to that worker.
- When the agent's spawn record holds no session, the session herdr still
  reports for its pane (`agent_session` in `herdr pane list`) is resumed
  instead, but only when it is a full session id and the harness's own
  transcript for it exists (`~/.claude/projects/<cwd>/<id>.jsonl`, or a
  Codex `rollout-*.jsonl` under `~/.codex/sessions`). The id is written into
  the spawn record before the harness starts; a dry run writes nothing.
  Without such a session the line still says `its spawn record holds no
  native session to resume`.
- A Claude Code agent the Lord quit himself (`/exit`, `/quit`, Ctrl-D or
  Ctrl-C twice) is reported `it was told to exit` and left alone.
  `claude-hooks/agent-exit-marker.py`, registered globally for `SessionEnd`
  and `SessionStart` by `ensure-harness-setup`, writes `told-to-exit` into the
  agent's data directory when Claude Code ends with reason
  `prompt_input_exit`, and removes it when a session starts again in a pane
  carrying that agent's `THRONE_AGENT_NAME`. Every harness the throne starts
  exports that name itself (`src/herdr/herdr-launch.ts`), because a pane herdr
  restored after a restart has lost its tab's environment. A harness killed by
  a signal (reason `other`, as a herdr restart does) leaves no marker and is
  brought back as before. Codex agents are always brought back as before: Codex's
  `SessionEnd` reason is always `other`, so a quit cannot be told from a kill.

The colours live in the `agentSettings` section of `config.user.ts`
(`docs/CONFIG.md`), re-read on every tick:

| kind of agent | default colour |
| --- | --- |
| Regent | `red` |
| Stager | `green` |
| Alpha | `blue` |
| Shadow | `purple` |

`agentSettings.colourByRole` replaces the colour of the roles it names, and
`agentSettings.checkEnabled: false` switches the check off: the worker then
does nothing and this command prints that the check is switched off.

Limits, shared by the timed tick and this command and kept in the agent's data
directory so a backend restart does not reset them:

- A correction that was typed and is still wrong at the next tick is typed at
  most 3 times per agent and setting. The fourth tick reports `gave up after 3
  tries` once, and the setting is left alone until the wanted value or the
  agent's session changes. `skipped-busy` is not a try. A value whose command
  left a dialog open is reported as failed and never typed again.
- An agent is brought back at most 3 times in an hour. After that it is
  reported once and left alone until its tab or its spawn record changes.

Flags: `--dry-run` runs every read and every decision and prints what would be
typed or brought back, and types, revives and records nothing. By default the
tick runs inside `throne-backend` over REST, in turn with the timed tick;
`--local` (or `--transport local`) runs it in the calling process. A REST
failure exits non-zero naming `--local`; it never falls back on its own.

## no-idling

```bash
./bin/throne-cli no-idling [--notify] [--local]
```

`throne-backend` runs this sweep every minute and sends its notices; run by
hand without `--notify`, it reports and sends nothing. Besides waking idle Alpha
families, each sweep checks every `deferred` queue row and pings the Regent
with one `send-agent` line per reason that applies:

- every objective the row waits on is done (complete, or its delivery is
  recorded as delivered):
  `Deferred <code> can start: <deps> are done. Run release-deferred.`
- an objective it waits on is abandoned, or no queue row has that code:
  `Deferred <code> waits on <dep>, which is abandoned. Release or abandon it.`
  (`which is missing` for a code with no row);
- the row has been deferred for more than 24 hours, whatever it waits on:
  `Deferred <code> has been held for <n> h waiting on <deps>.`

Each row and reason (and, for the second, each dependency) is pinged at most
once an hour. The last ping time is stored in the queue database, so a backend
restart does not reset it. Pings stop once the row is no longer deferred. An
unreadable queue skips the check with one line on stderr.

Each sweep also reports every live herdr agent row with no name (a harness
whose pane lost its herdr agent name, so it cannot send or receive and
`agent-statuses` shows its owner as DEAD). A pane is reported only once it has
been seen unnamed on two consecutive sweeps for the same agent session, so the
short window between a launch and `create-agent`'s own rename never pages
anyone. The Regent then gets one notice per sweep listing every such pane: when
the tab label matches a live or reaped ledger agent, the notice gives the exact
`herdr agent rename <pane id> <owner name>`; otherwise it says the owner is
unknown and the pane must be inspected. The notice repeats every sweep until
the pane is named again, waits while the Regent cannot accept notices, and the
sweep never renames anything itself.

Each sweep also reads the input box of every live Alpha, every live Shadow and
the Regent (matched by name). When the same non-empty text has sat there for a
minute or more across two sweeps, the sweep submits it with the forced Enter
(the same press as `send-agent --enter-only`): one read of the box, one key
press, no lock; it never types, clears or retypes anything. A box still stuck
on a later sweep is pressed again on every sweep, with no cap. This is the one case where a draft is submitted with no
delivery waiting, by the Lord's order of 2026-11-12. Stager boxes are never
touched. A box showing a menu or question, a box that cannot be read, text that
changed since the last sweep, and a pane the stranded-spawn recovery handled in
the same sweep are left alone. Each press writes one log line naming the agent
and the first 80 characters; a refused or failed press is logged too, and the
Regent gets no notice for a box that stays stuck. Without `--notify` the sweep presses nothing and prints the panes it
would press.

## throne-startup

```bash
./bin/throne-cli throne-startup
```

The SessionStart-hook entry point — self-configures a freshly launched throne
harness with no manual steps. Resolves its own herdr pane; if the pane isn't in
the roster or its `cwd` isn't the throne root, it's a full no-op (so a
broadly-scoped hook fires harmlessly for every non-throne session). Otherwise
renames itself to `Regent`, but ONLY when it is unnamed AND no `Regent` already
exists (never re-renames a named agent, e.g. a `create-agent`-spawned Shadow),
**banners the Regent's desired-state** (`RUNNING`|`DISMISSED`, read via
`regentstate.ts`'s `readDesiredState` seam so the self-heal mode is never
hidden), **prints a compact QUEUE digest to stdout** from
`~/.throne/data/regent/QUEUE.md` (the in-flight 🟢 /
next-up ⚪ objective headings plus the file path — so a booting Regent's opening
context already holds the backlog with no manual `cat`), then always runs the
`ensure-heartbeat` core regardless of the rename outcome. The timer only
resolves and messages; the Regent reads the queue, reconciles live/current
campaign state, continues or merges active work, and only when there are no
current tasks dispatches the next dependency-eligible queued objective. Every
failure path is caught and logged; the command always exits 0 so it can never
disrupt harness launch.

The desired-state banner and the digest both print for ANY confirmed throne-root
pane (never in a no-op session), and both fail safe: an unreadable marker banners
`RUNNING`, an unreadable queue prints "no queue found" — neither aborts launch.
The digest reads `~/.throne/data/regent/QUEUE.md`, resolved from the
module dir (like `THRONE_ROOT`, never cwd), and lists only open
(🟢/⚪) objectives — landed ✅ items are omitted. The mechanism is just stdout:
the SessionStart hook's output is already injected into the harness's opening
context.

The hook never raises the Stager. For a confirmed Regent it runs startup
reconciliation and stops there; a running court with no live Stager heals
within a minute through the backend's `court-liveness` worker, which brings
back a registered dead Stager or creates one through the Stager floor. A live
Stager is a no-op, ambiguous evidence refuses, and `dismissed` says
`STAY DOWN`.

## migrate-home

```bash
./bin/throne-cli migrate-home [--backup-dir <folder>] [--keep-old-copies] [--leave-browser-profiles] [--include-checkout-config]
```

Moves an older install's files into the throne home (AGENTS.md "Where the
throne keeps things"): `private-refs.txt` from
`~/.config/throne` into `~/.throne/config/`, and the agent-browser sign-ins
into `~/.throne/browser-profiles/`. `throne-startup` runs it each time it
starts a Regent session, with `--keep-old-copies` and without the checkout flag, so startup only copies
what is missing into the throne home and never removes or moves an old file or
writes `MOVED.txt`; running `throne migrate-home` by hand finishes the move. A
refusal or error at startup is printed and never fails startup.

Per item: an old file whose new place is empty is moved, and the old folder
gets a `MOVED.txt` naming the new places; an identical pair is finished by
removing the old copy; a pair that differs is refused, its difference printed
and nothing changed for it, and the command exits 1; a browser profile a
running browser holds is reported as held and left for a later run. Before the
first move every item to be touched is copied into the backup folder
(`--backup-dir`, default `~/tmp/throne-home-backup-<time>`); nothing is backed
up when there is nothing to move. A second run changes nothing. Logs are never
moved, and nothing else under the throne home is touched.

- `--keep-old-copies` copies instead of moving and leaves every old file in place
  with no `MOVED.txt`, for processes still running old code that read the old
  paths; a later plain run finishes each identical pair.
- `--leave-browser-profiles` leaves the sign-ins where they are.
- `--include-checkout-config` also moves the live checkout's `config.user.ts`
  into `~/.throne/config/`, writing a `package.json` of `{ "type": "module" }`
  beside it; without it the checkout copy stays, and still wins.

Output is one line per item (moved, already in place, nothing to move,
refused with its difference, held), plus the backup folder when one was
written. Exit codes: 0 done, 1 an item was refused, 2 bad arguments (the usage
is printed); `--help` prints the usage and exits 0.

## restart-harnesses

```bash
./bin/throne-cli restart-harnesses [--dry-run] [--force] [--only <name>]...
```

Restarts every live agent's harness process in place so the court runs the
binary `vendor-pins.json` currently pins — the step after `update-harnesses`,
whose `npm install --prefix vendor` never touches a process that is already
running. Per agent: the live native session id is recorded into the ledger
`spawn.json`, and so is the model the pane is actually running: the newest
assistant turn of the session transcript decides it, and when it differs
from the recorded `model` (a Stager or Regent the Lord moved with `/model`)
the ledger is rewritten with that model and a `switched_at` before the stop,
so the resume relaunches on the model the Lord left it on rather than the one
it was spawned with (Lord, 2026-09-14: the restart "can sometimes forget the
model it was previously on"). The harness gets `SIGTERM` (then one `SIGKILL`
after 30 s, then a loud failure), the agent is resumed through the
startup-reconciliation resume path into its EXACT native session in the same
pane, and the pane is renamed back to the registered name if the relaunch
surfaced as a bare `claude`/`codex`. The relaunched pane must then be running
the vendored binary: anything else is `failed`, naming the executable path,
except for an agent whose spawn record holds `harness_executable`, which runs
that executable by design. A pane with no harness process is `failed` for every
agent, and a `restarted` line names what is running. The Regent goes after the others,
under the resurrect lock, and the invoking agent goes last.

A real run with the invoking pane among its targets hands itself to a detached
process in its own session, prints the log path and exits `0` at once. That
run appends a header, every outcome and a closing count to
`~/tmp/restart-harnesses.log`.

A Claude agent is relaunched with throne's mod (`--plugin-dir extensions/claude`)
when the installed Claude Code passes `claude plugin validate` on it, and
without it otherwise; its
`spawn.json` `claude_mod` records which. A restart also records and passes a
`delivery_socket` for an agent launched without one, which is how running
agents move onto the socket.

Skipped, with a reason on stderr: agents whose status is `working` unless
`--force`, and unnamed panes. Reported `failed` and left running: agents with
no herdr-visible session id. `--dry-run` prints the plan and changes nothing. A
foreground run exits `0` when no restart failed, `1` when one did, `2` on a bad
argument.

## schema-migration-guard

```bash
bun scripts/schema-migration-guard.mjs
```

Exits 1, naming the schema file and `bunx drizzle-kit generate`, when the Drizzle
schema has changed and no committed migration in `drizzle/` covers it; exits 0
otherwise. It writes only into a temporary folder. `bun run build` runs it before
compiling and `bun run test` runs it inside the container before the tests. Write a
migration with `bunx drizzle-kit generate --name <what changed>` and commit it
(`agent_docs/database.md`).

## update-throne

```bash
bun scripts/update-throne.mjs --check
bun scripts/update-throne.mjs [--bring-in-upstream] [--restart-ordered-by-lord "<words>"]
```

Brings a throne install up to date in one step. It is a plain script, not a CLI
command, because it must load and pull when `dist/` is stale or broken. Run it
from the main checkout; the `/update-throne` skill runs it and asks its
questions.

A run works out what the checkout is, and prints it as
`update-throne: checkout: <private|public|fork> (<reason>)`, from remotes only:
an origin whose repository name ends `-private` is the private repo, a remote
named `upstream` makes a fork of that remote, an origin on github.com that the
public API reports as a fork is a fork of its parent, and anything else is
public. A host that cannot be asked reads as public, and the line says so.

It then fetches the source's default branch, read from the remote, and plans
before anything changes, reading each pin with `git show` from the commit or
tree the pull will leave: the fetched commit for a fast-forward, and for a fork
that will make a merge commit, the tree `git merge-tree --write-tree` makes.
`--check` stops there: it prints the plan and each `question:` line, changes
nothing else, and exits 0.

Every refusal comes before the first change, and nothing is discarded: another
run still running, a linked worktree, another branch, a dirty tree, a diverged
branch (except on a fork), a fork's merge that will conflict, or herdr moving
with no restart word. A private
or public checkout fast-forwards only, which needs no git identity because it
makes no commit. A fork brings in upstream only with `--bring-in-upstream`, and
never pushes. A fork that is only behind fast-forwards the same way; only a
diverged fork's merge makes a commit, so only that merge needs an identity, and
a merge that stops is abandoned. Without that flag, a fork with new upstream
commits is left alone and the run ends with exit 0.

After the pull, in order: `mise install bun` when the pinned Bun is missing,
`bun install --frozen-lockfile` when `bun.lock` differs from
`vendor/.stamps/dependencies`, `bun run build` when `dist/` is behind source,
`update-harness.mjs pinned` for each harness, and `install-services`. Every step
after `mise install bun` runs on the pinned Bun, so a moved Bun pin builds on the
new one.

Restarts, only these. When herdr moves, `herdr-upgrade.mjs --pinned` restarts
herdr, the bot server, each running `throne-bot-bridge@` instance and the backend
and relaunches every agent, and every other service owed a restart restarts
first, before the report and that hand-off, so nothing is left to a second run.
macOS has no bot server or bridges, and a changed backend plist reloads before
the hand-off, because the kickstart keeps the old job definition. Otherwise
`throne-backend` restarts when its running generation is not the current `dist/`
generation, and is reported as not restarted when it left no generation marker
to read, each running service whose installed file or pinned image changed
restarts, `ntfy`, `conduwuit` and `forgejo` restart when the pull changed the
script or config they run from the checkout, each running `throne-bot-bridge@`
instance restarts after a build publishes a new `dist/` generation (macOS has no
bridges), and this checkout's own `bin/throne-cli restart-harnesses --force` runs
when a harness moved and the word was given, whichever `throne` is first on PATH.
A harness that moved with no word leaves the agents on the old binary, and the
report says so. A changed `throne-herdr` or `throne-bot-herdr` file with no herdr
move is reported and not restarted, because that restart ends the agents in it.
`install-services` starts a stopped service, so a service owed a restart that
was stopped is started, then restarted, and the report says restarted. One that
is still not running at that point is reported as not restarted.
Restarts still owed are kept in
`vendor/.stamps/update-throne-pending-restarts`, so a later run finishes them.
A step is owed before it runs, so a killed run still owes it. A harness step that
fails with the vendored version unchanged takes `agents` back, and one that moved
the binary keeps it. A restart handed to a detached run stays there too, beside
its log path, until a later run reads success: `restart-harnesses` hands over from
an agent's own pane, and `herdr-upgrade.mjs --pinned` always does, so what the
herdr restart covers, the agents included, is owed from before that step until
then, and a step that stops before the hand-off owes only what was owed before it.
A run, `--check` included, reads the last section written to that log since the
step began, never an older run's. Success clears what the restart covered. A
failure, a missing log, or a log quiet for 30 minutes with no verdict keeps it
owed and drops the path: `--check` asks, a run with no word prints
`report: not restarted agents`, and a run with the word retries. A log with no
verdict yet means the restart is still running, so a run refuses and `--check`
says it would. A log no longer than it was when the step began means the step
never started, so it counts as not succeeded at once; a log that grew with no
verdict keeps the 30-minute rule. `--check` writes none of this to the pending file.
When `install-services` fails, what it named is kept there too, and the next run
reloads the systemd units before it restarts anything.

The report prints as `report:` lines before the steps that can end the run's own
pane: `report: throne <old> -> <new>`, `report: <name> <old> -> <new>` or
`report: <name> <version> unchanged`, `report: restarted <what>` and
`report: not restarted <what> — <why>`. The agent restart follows as
`report: restarting every agent, ...`, then `report: restarted every agent`, or
`report: handed every agent's restart to a detached run, which is not yet a
result; read <log>`, with exit 0; a herdr hand-off says the same of herdr's
restart. Every run that gets that far ends through
`herdr-upgrade.mjs --pinned`, which checks that the CLI's herdr version equals
the running service's. A herdr release installed above the pin leaves `bin/herdr`
off the pin, which no restart can change, so that step refuses, restarts nothing
and fails the run until the release is removed.

Every line starts `update-throne: ` and is appended to
`~/tmp/update-throne.log` under a `===== update-throne <mode> <time> =====`
header. A refusal is `update-throne: REFUSING — <why>` and a failure is
`update-throne: FAILED: <why>`. A second run after a failure finishes the work.
Exit codes: 0 done or nothing to do, 1 refused or failed, 2 a bad argument.

## account

```bash
./bin/throne-cli account list
./bin/throne-cli account add <name>
./bin/throne-cli account switch-long-running <name>
```

Manages the Claude account folders agents run on, as listed in
`~/.throne/config/accounts.json` (keys `accounts`, `longRunningAccount`,
`companyLogin` and `mcpServersAllowedOnEveryAccount`; see `docs/CONFIG.md`).

- `list` prints, per account in list order: its folder; its login (logged in
  or out, the email domain and organisation from that folder's own
  `.claude.json`, never the email's local part, and whether it matches
  `companyLogin`); its 5-hour and weekly used percentages with the reading's
  age and source, for example `(read 3 min ago, last good after a 429)`, the
  source being `fresh`, `cached`, or `last good after a 429` (see
  `plan-usage-remaining` for the cache); the live agents on
  it (from each live agent's `spawn.json` `account`, the primary when absent);
  the MCP servers from `~/.claude.json` it gets at launch and the ones it is
  denied (the company login gets all; any other account only
  `mcpServersAllowedOnEveryAccount`); whether its claude.ai connectors are
  `on at launch` (the company login, launched without `--strict-mcp-config`)
  or `switched off at launch` (any other account, launched with
  `--strict-mcp-config` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`); and, for a
  non-primary folder, link drift (a shared link missing, pointing elsewhere,
  or a real file in its place). The last line names the long-running account. Without
  `accounts.json` it prints one line saying the throne runs on `~/.claude`.
- `add <name>` creates `~/.throne/accounts/claude/<name>/` (mode 700) and links
  `CLAUDE.md`, `skills`, `hooks`, `plugins`, and `agents` and `commands` when
  present, to `~/.claude/<item>`; `settings.json` links straight to the real
  file `~/.claude/settings.json` points at, so a fresh folder's settings
  migrations never replace the primary's own link. It writes the folder's
  `.claude.json` (only when absent) with the settings-migration state from
  `~/.claude.json` (`migrationVersion` and every `*MigrationComplete` key)
  and `hasSeenAutoDefaultNudge: true`; never a login, `projects` or
  `mcpServers`. It installs the Keychain stand-in
  (`src/account/security-stand-in`) as `~/.throne/accounts/claude/bin/security`
  when missing, records the account in `accounts.json` (creating the file with
  `primary` = `~/.claude` first), and prints the login command. A folder that
  already holds a Claude config is registered, not recreated; correct links
  are left alone, a link pointing elsewhere is replaced, and a real file where
  a link belongs is reported and left. A non-empty folder that is not a Claude
  account folder is refused. Logging in stays the Lord's act: run the printed
  command, type `/login`, sign in, then `/exit`.
- `switch-long-running <name>` refuses an unknown or logged-out account,
  naming the configured ones. Otherwise it records `longRunningAccount`, so
  every Stager and Regent spawned or resumed afterwards starts on it, and moves
  each live Stager and the Regent there: it copies the agent's session
  transcript (`projects/<project folder>/<session>.jsonl` and the session's
  same-named folder) from its current account folder into the target's (the
  original stays), sets its `spawn.json` `account`, then restarts it in place
  through `restart-harnesses` (forced; the invoking agent last, the Regent
  under its lock). An agent with no `spawn.json` is moved from the primary
  the same way and relaunches on the long-running account, as every Stager
  and the Regent with no recorded account does. One line per agent: `moved`,
  `unchanged` (already on the target), or `failed` (no session id, a session
  transcript that cannot be found, or a failed restart).
  The balancer never moves Stagers or the Regent; only this command does.

`check-config` also shows each switch of the `features` section of
`config.user.ts` with its value and its
default of off, and one line when a leftover `features.json` is no longer read. It adds one line per configured account: name, folder, logged in
or out.

`check-config` also prints, per harness in the `harnessEnvironment` section of
`config.user.ts`, the names of the variables it adds to that harness's agents.
It never prints a value.

Exit codes: `0` done; `1` an agent could not be moved or an unexpected error;
`2` a bad argument or a refusal (unknown or logged-out account, a foreign
folder, an invalid accounts file).


A second kind of account, a **provider account**, holds the key of a
third-party model provider. Today the only provider is `deepseek`, used by the
`pi` harness: its entry names a key file (mode 600), and `account list` shows it, without the key, beside the
agents running on it. A pi launch reads the file and passes the key only as
`DEEPSEEK_API_KEY` in the pane's environment.

## plan-usage-remaining

```bash
./bin/throne-cli plan-usage-remaining [--json]
```

Reports how much Claude plan-usage headroom remains from authenticated `GET
https://api.anthropic.com/api/oauth/usage`, the same source the first-party
`claude` CLI renders as `/usage`. This endpoint is undocumented and has shown
schema drift, so throne normalizes only observed fields and never supplies a
missing value. Its `utilization`/`percent` values are already 0–100 percentages,
and every `resets_at` string is passed through byte-for-byte.

The normalized Fable/Opus rules are exact:

- `five_hour` becomes the general `5h` window and applies to both native Fable
  and native Opus when readable.
- `seven_day` becomes aggregate `weekly`. A structured
  `limits[].kind === "weekly_scoped"` row whose `scope.model.display_name`
  matches the requested model is that model's weekly authority; aggregate
  `weekly` is fallback only when no matching scoped signal exists.
- A non-null legacy `seven_day_opus` becomes exactly one `weekly:Opus` window
  only when no structured Opus-scoped row exists. Structured Opus data wins;
  the normalizer never emits both structured and legacy Opus windows.
- A scoped row whose model is readable but percentage is malformed is retained
  in `unreadable_windows` rather than silently discarded. This prevents an
  exact-model malformed row from accidentally making aggregate `weekly` look
  authoritative; malformed scoped rows for another model remain irrelevant.
- `src/create-agent/native-availability.ts` evaluates only canonical `claude/fable` and
  `claude/opus`. A readable `5h` plus the selected weekly signal are checked
  independently. Fresh, finite, in-range `remaining_pct <= 0` yields
  `exhausted` with the exact exhausted cap/reset evidence. Duplicate relevant
  windows, malformed/out-of-range relevant percentages, or no readable
  applicable allowance yield `unknown`, never manufactured exhaustion.

Default mode prints a short human-readable summary. `--json` prints the
machine-consumable `source`, `harness`, `as_of`, `windows[]`, and optional
`unreadable_windows[]` shape. Readable window entries carry `cap_window`,
`used_pct`, `remaining_pct`, `reset_time`, and `severity`; model entries also
carry `scope_model`. A window the endpoint reports as not applicable is omitted
rather than fabricated as zero.

It is a pure reader of `~/.claude/.credentials.json` (the macOS Keychain
item on darwin): it never writes the store and it NEVER refreshes the token.
An expired access token is reported as an honest failure until a Claude Code
session refreshes it on its own next request. The refresh it used to perform "only in memory"
was the cause of the Lord's recurring logouts (found 2026-09-10): Anthropic
rotates the refresh token on every grant, the throne never wrote the rotated
token back, so every Claude Code session was left holding a dead refresh
token and was logged out at its next refresh. The same rule the Codex reader
always followed now binds this one.

Every Claude usage read, for every account and every caller (`create-agent`,
`account list`, this command, the harness steer), goes through one cache file
per account folder:
`<throne data home>/usage-cache/claude-accounts/<folder path with / as ->.json`,
under `THRONE_DATA_HOME` (default `~/.throne`). The file holds the account's
last good reading and its back-off; it is written to a temporary file and
renamed into place, so concurrent writers never leave a torn file, and no
reader ever waits on another process.

- A reading younger than `USAGE_READING_FRESH_MS` (2 minutes) is reused
  without a request and marked `cached`.
- An older reading is refreshed by one process: it claims the refresh with an
  exclusive `<file>.refreshing` (a claim older than a minute is treated as
  abandoned), and every other process at that moment returns the last good
  reading marked `cached` at once. With no last good reading there is nothing
  to share, so each reader asks the endpoint.
- An HTTP 429 starts a back-off of 5 minutes, doubling on each further 429 to
  at most 30; no request is sent while it lasts, and a successful read clears
  it. During a back-off, or on the 429 itself, the last good reading is
  returned marked `last good after a 429`, with its original `as_of`. An
  account that never had a good reading stays unreadable.
- A live read is marked `fresh`. Only fresh readings are appended to the
  usage log.

The payload's `reading_source` field (in `--json`) carries `fresh`, `cached`
or `last good after a 429`; human mode adds `(<source>, read <as_of>)` to a
reused reading. A cached or last-good reading keeps its real numbers and
counts as a usable reading for the account balancer and the harness steer. This same
cache-backed, at-most-one-read source is exported as `getUsagePayload`; the
availability adapter converts a rejected call or `source: "error"` payload to
`source-failure`. The live source persists a bounded JSONL history at
`data/stats/usages/usage-log.jsonl`; `boundUsageLogRows` keeps only valid
non-future rows no older than eight days and then applies one global newest-
4,096 cap after filtering, so the cached read is a reuse layer over a finite
sensor ledger rather than an unbounded log.

Every failure mode with no cached reading to fall back on —
missing/unreadable/malformed credentials, an expired access token, a failed
usage request, or a response that doesn't match the expected usage schema —
exits non-zero with a clear cause: a stderr line in the default mode, or a
`{"source":"error",...}` object in `--json` mode. It never prints a
fabricated percentage.

## codex-usage-remaining

```bash
./bin/throne-cli codex-usage-remaining [--json]
```

The Codex counterpart to `plan-usage-remaining` above: reports how much
Codex (ChatGPT) plan-usage headroom remains, read from `~/.codex/auth.json`,
in the same `source`/`harness`/`as_of`/`windows[]` shape (the codex response
may omit the `5h` session window entirely — an absent window means
unconstrained on that axis, never exhausted). Same read-only guarantee (never
writes `~/.codex/auth.json`), and its own last-good cache at
`~/.throne/usage-cache/codex.json`: a reading younger than 30 minutes is
reused, a live-fetch error returns the last good reading marked `stale: true`
with the live error, the command still exits 0 on a stale reading, and the
same `getUsagePayload` reuse seam applies. The command is owned by the Nest
`UsageAdaptersService`; the legacy pipeline root remains an internal
implementation boundary until its zero-reference proof is complete.

## resource-pressure

```bash
./bin/throne-cli resource-pressure [--json]
./bin/throne-cli resource-pressure --form-baseline
```

Reports current host capacity pressure. The verdict line is the
pressure-signal domain's own figure — `classifyPressure`'s
`max(cpu.avg10, cpu.avg60, memory.avg10, memory.avg60)` against the Lord's
standing 70 threshold — i.e. exactly the number the alpha-autoscale admission
gate and keep-going report already act on, so this command can never disagree
with the throne's own admission decisions. Around it: all three PSI windows
(avg10/avg60/avg300) for cpu, memory, and io (io is explicitly informational
and outside the verdict), load averages against the cpu count with a per-core
ratio, and `MemAvailable`/`MemTotal` from `/proc/meminfo`. On macOS (since
2026-09-02, the Lord's order that the autoscaler support mac) there is no PSI:
the verdict comes from `src/pressure-signal/darwin-pressure-reader.ts` through
the same classifier and thresholds — cpu is utilisation over the one-second
interval line of `iostat -n 0 -c 2 -w 1` (Bun froze `os.cpus()` across a
synchronous sample, 2026-11-18), memory is the kernel's memorystatus subsystem
(`100 - kern.memorystatus_level`, floored to 70 at WARN and 100 at CRITICAL by
`kern.memorystatus_vm_pressure_level`), io stall is not measurable and is
graded 0 with that stated in the report, and the memory line comes from
`hw.memsize`. The report prints `source: darwin` and no PSI window lines in
that case. Observe-and-report
only — nothing here can launch, nudge, or reap. Every input degrades
independently: a missing PSI file renders as `unavailable`, an unreadable
verdict input renders as a stated `unknown` (never defaulted into either
verdict), and partial input is stated in the output rather than converted
into a failing exit. `--json` emits the same snapshot as one JSON object with
no derived opinions.

### Responsiveness against a quiet baseline

Directly under the verdict lines the report prints how responsive the home
disk is right now, against the same machine when it was quiet:

```text
  responsiveness: git 4.2× baseline (41 ms) · disk 9.0× baseline (9 ms)
```

Two probes, each timed in milliseconds in the calling process (the only child
process is `git` itself):

- **git**: `git status --porcelain` in a dedicated probe repository,
  `<probe folder>/repo`, created on first use with 200 small committed files.
  It is never a real checkout, so a merge's lock in a live tree is never what
  gets measured, and its size never grows.
- **disk**: a 4 KiB write to `<probe folder>/disk-probe` followed by fsync.

The probe folder sits on the disk that holds `$HOME`, where agents' work
lives: `${THRONE_DATA_HOME:-$HOME/.throne}/pressure-probe/` when the data home
is on the same device as `$HOME` (compared with stat, not by path), otherwise
`$HOME/.cache/throne/pressure-probe/`.

**Quiet.** The machine is quiet when every input is under its number:

| Input | Linux | macOS | Quiet below |
| --- | --- | --- | --- |
| cpu | PSI cpu "some" avg60 | utilisation over the one-second interval line of `iostat -n 0 -c 2 -w 1` | 5 |
| disk | busiest physical disk's busy % (the verdict's own disk-busy reader) | not measurable, graded 0 | 5 |
| memory | PSI memory "some" avg60 | `100 - kern.memorystatus_level` | 1 |

On Linux the disk input is the busy %, not io PSI, because io PSI "some"
avg60 can read 80–84 on an idle machine from io_uring idle waits,
the same reason the verdict grades disk-busy instead of io PSI. An unreadable
input counts as not quiet (`cpu pressure unreadable`). On macOS the memory
figure is the share of memory not free, which a running Mac rarely holds under
1, so there the baseline mostly forms through the `y` at the prompt below and
the sweep seldom adds samples. A machine that is not quiet is stated in one
line, for example `disk busy 60% — the machine is not quiet`.

**Baseline file.** `${THRONE_DATA_HOME:-$HOME/.throne}/pressure-baseline.json`,
written atomically (temporary file, then rename). Per probe it holds the
samples (milliseconds and when taken) from the last 7 days and their median;
older samples are dropped on every write and ignored when comparing. It also
records the machine it was taken on (CPU model, kernel release, the device
`$HOME` is on) and whether it was formed under load, with the reason. A probe
shows a ratio only once it has 20 in-window samples; until then it reads
`git 41 ms (no baseline yet, 7 of 20 samples)`. A baseline whose machine
fields differ from the current machine (a kernel update counts) is never
compared: the line reads `git 41 ms · disk 9 ms (baseline from another
machine)`. A baseline formed under load appends `(baseline formed under
load)`. A probe failure reads `responsiveness: probe failed — <reason>` and
the command still exits 0. `--json` adds one key, `responsiveness`, with the
same facts as data: `state`, `baseline` (`compared`, `missing`,
`another-machine`), `formedUnderLoad`, and per probe `currentMs`, `medianMs`,
`ratio` (or null) and `sampleCount`, or `state: "failed"` with `error`.

**`--form-baseline`** takes 20 rounds of both probes 1.5 s apart (about 30 s)
and replaces the baseline file with them; rerun it after a disk, kernel or
cooling change. It checks quiet first:

- quiet: forms it, prints the medians and the file path, exits 0;
- not quiet with a terminal on standard input: prints the reason line and asks
  `Form the baseline at the current load anyway? [y/N]`; `y` or `yes` forms it
  and records in the file that it was formed under load; anything else (an
  empty answer, `n`, Ctrl+D) forms nothing and exits 1;
- not quiet without a terminal: prints the reason line, forms nothing, exits 1,
  and never reads standard input.

`install.sh` runs it in a "Pressure baseline" step right after compiling and
before the harnesses and the court start. A refusal prints one warning that
the baseline will form on its own from quiet moments, and the install
continues.

**The rolling update.** Every autoscale sweep that holds the sweep lock, cron
and `autoscale-now` alike, probes once, logs one line with the times and
ratios, and adds the two samples to the baseline only when the machine is
quiet at that moment; samples taken while not quiet are never added. A quiet
sweep that finds a baseline from another machine starts a new one for this
machine. A probe failure is one log line and changes nothing else in the
sweep. `autoscale-status` shows the same line from a fresh probe plus the
baseline file.

Nothing here changes a launch decision: the verdict, its inputs, the launch
budget and capacity are untouched. The responsiveness line is reported only.

## opencode-go-usage-remaining

```bash
./bin/throne-cli opencode-go-usage-remaining [--json]
```

Reports OpenCode Go usage as a provider distinct from Codex ChatGPT, even
though both may execute through `codexy-all-omni`. The evidenced quota source
is the authenticated workspace dashboard at
`https://opencode.ai/workspace/<workspace>/go`, configured with
`OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` (the `OMNIROUTE_`
prefixed variants take precedence). The inference API key can authenticate
`/models` and model calls but cannot read quota; the tested `/zen/go/v1/quota`
path returns 404. Missing dashboard credentials therefore produce an honest
unavailable result, never a fabricated zero.

The parser normalizes only dashboard-declared rolling, weekly, and monthly
usage percentages and relative reset intervals. It deliberately omits dollar
credit totals/capacity because the observed dashboard payload does not declare
them. Human and `--json` modes share the cache, stale fallback, bounded
provider-specific history, burn-rate input, and reset-aware forecast behavior
used by the Claude and Codex sensors. Cache/history identity is `opencode-go`,
so it cannot collide with Codex. Provider-qualified
`opencode-go/<model>` spawn routing consumes this sensor; other Codex-family
models continue consuming Codex ChatGPT telemetry.

## list-harnesses-and-models

```bash
throne-cli list-harnesses-and-models [--json]
```

A read-only registry view of valid model vocabulary, launcher mapping, runtime
the active preset, and its ordered role
pools. This is a live-court routing question, so the documented invocation is
bare. A checkout-local invocation from a linked worktree without
`config.user.ts` refuses before rendering plausible committed defaults and
names the resolved live throne root to query.
Every row is labeled `new-and-registered`,
`new-with-bypass-or-registered`, or `registered-resume-only`; shared GPT rows on
the non-selected harness carry the bypass label — a row's registration path, not
a `--bypass-harness` flag, since none exists. Human output also states that
the selected forward policy's fresh GPT path uses its shown launcher; a
`new-with-bypass-or-registered` alternate is selected by naming its model
directly with `--model`, not by any harness bypass flag.

`--json` emits `{source, active_plan, harnesses, forward_launch_policy,
scores_note}`. Disabled historical rows remain visible with
`launchPolicy: registered-resume-only`; they are excluded from fresh model
vocabulary and role pools. `forward_launch_policy` documents the selected GPT path, the
non-selected bypass-or-resume harness, and the legacy exact-resume
behavior. The command
never reads toggle state or live usage.


The `pi` harness lists exactly two models, `flash` and `pro`, both DeepSeek;
the rows show pi as their only harness.

## Service install (keep-going timer and the rest)

The user timer runs `keep-going` every 30 minutes (`OnUnitActiveSec=30min`,
`OnBootSec=5min`). Most unit sources under `systemd/` are TEMPLATES holding
`{{THRONE_ROOT}}` or `{{HERDR_BIN}}`, so copying those into place by hand
installs a broken unit; the timer itself is the token-free exception and would
copy verbatim. Install and enable through the throne either way:

```bash
./bin/throne-cli install-services            # whole set; --dry-run to preview
./bin/throne-cli ensure-heartbeat            # or: keep-going pair only
systemctl --user list-timers throne-keep-going.timer
```

## Tests

```bash
bun run test          # canonical — runs ONLY the throne's own tests
```

The default run skips two agent-chosen groups: `bun run test:slow` runs the files
listed in `test/slow-tests.json`, and `bun run test:containers` runs the files
listed in `test/container-tests.json` (tests that start a podman or docker
container).

Runs the hermetic guard suite with `bun test` inside the suite container,
scoped to the files `test/run-tests.ts` selects. **Prefer `bun run test` over a
bare `bun test` from the throne root**: a bare run skips the container and its
guards. Note `bun run test` and `bun test` are different commands.

To verify a single file directly: `bun test test/startup-guards.test.ts`.

### Queue-store proof containment

Queue-store tests and campaign proofs use a scratch `THRONE_DATA_HOME` by default. A live-store proof is permitted only when installed scheduling is the behavior under test; it must create uniquely prefixed campaign-owned IDs, forbid bulk or predicate deletion, and clean each owned row by exact ID through the attributed archive boundary. `trim-queue --apply` requires an explicit invoking actor (`--actor <actor>`), archives terminal rows, and records the actor, predicate, operation ID, timestamp, and row count durably.

## install-container-prerequisites.sh

`I_AM_AN_AGENT=1 scripts/install-container-prerequisites.sh [--check] [--help]`
installs what is missing of Podman, its Docker compatibility and the Docker
CLI, which `install-forgejo.sh` needs. It reads before it acts, so re-running
it is safe.

- A runtime that already answers `info` (the first of
  `THRONE_CONTAINER_RUNTIME`, `docker`, `podman` on `PATH`, the order
  `install-forgejo.sh` uses) is left exactly as is, Docker Desktop and
  docker-ce included.
- macOS: Homebrew `podman` and `docker` formulas, `podman machine init` when
  no machine exists, `podman machine start` when it is not running, then a
  `podman` docker context pointing at the machine's socket
  (`podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'`)
  and `docker context use podman`. It never installs Homebrew or Docker
  Desktop.
- Linux: `podman` and `podman-docker` (the package that provides a `docker`
  command backed by Podman on Debian, Ubuntu, Fedora, Arch and openSUSE)
  through `apt-get`, `dnf`, `pacman` or `zypper`, then
  `systemctl --user enable --now podman.socket`. An `rpm-ostree` host never
  has packages layered. Root steps use `sudo` only when `sudo -n true`
  succeeds; it never prompts.
- It ends by proving `docker info` answers.
- `--check` changes nothing. `--help` prints usage.

| Output | Exit |
| --- | --- |
| `container runtime: ready (<docker\|podman>)` as the last line | 0 |
| one `missing: podman`, `missing: docker cli` or `missing: a reachable container engine (docker info fails)` line per gap, then `container runtime: missing` (`--check`) | 1 |
| `docker info` still failing after installing, then `container runtime: missing` | 1 |
| `needs you: <exact command or fact>` — no Homebrew, an image-based host lacking packages, root needed without passwordless sudo, no known package manager, an unsupported system | 2 |
| unknown argument | 2 |
| `I_AM_AN_AGENT=1` not set | 3 |
