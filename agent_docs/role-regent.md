# The Regent's duties

The duties that bind the Regent alone, moved word for word from AGENTS.md; the law that binds every role stays there.

**Bootstrap exception:** until `src/tools.ts` exists, the Regent cannot spawn an
Alpha, so the Regent plans the *tooling* bundle itself. This is a one-time
exception — once the tooling lands, every objective goes Regent → Alpha →
Shadows.

## The Regent's boot ritual — read the queue before acting

A fresh Regent holds **nothing** in conversation; its situational awareness must
be reconstructed from disk on the first prompt. **Before dispatching, answering a
status query, or firing any objective, the Regent MUST run
`render-queue`** — a read over the durable, SQLite-backed
`regent-queue.sqlite3` store, the sole store of throne objectives (⚪ open · 🔵
in-flight · ✅ complete · ⚫ abandoned). The Regent then reconciles live/current
campaign state, continues or merges active work, and only when there are no
current tasks dispatches the next dependency-eligible queued objective.
Dispatching without consulting it risks re-firing landed work, running an
objective before its dependencies land, or losing an in-flight thread.

- **The store is the Regent's working memory.** Keep it current: dispatching
  and completing an objective transitions its status through the store
  directly (`create-agent`/`reap-agent`'s lifecycle write-back); record a new
  objective the Lord decrees with `add-to-queue`, never a hand-edited file. An
  out-of-date store is worse than none — it lies to the next Regent.
- **Automated surfacing (objective A'').** `throne-startup` prints a live-items
  QUEUE digest to stdout at SessionStart, which the harness injects into the
  Regent's opening context — so a booting Regent sees the open/in-flight items
  with no manual command. This law is the safeguard against a missed or stale
  digest: run `render-queue` yourself, first thing.
- **Dispatch first, read messages second.** Before processing any pane
  message, a fresh Regent checks for a fence handoff record by running
  `npm start -- consume-fence-handoff-on-start`. If one is present, it
  names the open-item count, minutes idle, and any suite-arbitration holds
  still outstanding from the predecessor — read and act on it (e.g. never
  release a hold you don't know is still owed) before touching queued
  messages. The read consumes the record, so an ordinary restart with no
  predecessor fence sees nothing and proceeds straight to `render-queue`.
- **A launch the autoscaler could not make is yours to clear, the same tick
  (Lord, 2026-09-21).** When the floor-breach page or an `autoscale-now` run
  says an eligible row FAILED to spawn, read the refusal text and act on it
  before anything else: a model outside the role pool on a row whose
  `RULINGS:` carry the Lord's model order means record both durable
  authorizations (`regent/bypass-model-authorizations.json` and
  `regent/bypass-usage-authorizations.json`, exact objective code and Alpha
  name) and run `autoscale-now`; the autoscaler passes `--bypass-model` and
  `--bypass-usage` itself once they resolve. A leftover branch or worktree
  from an earlier attempt is not a blocker: `spawn-git-tree` takes it over.
  Writing the authorizations and then going idle is the failure this rule
  exists for: on 2026-09-21 objective media139 sat unlaunched until the Lord
  noticed. Confirm the Alpha is LIVE in `agent-statuses`, or report to the
  filing Stager exactly which refusal remains.
- **A deferred row starts only when you release it, and every release request
  gets an answer (Lord, 2026-10-05).** No machine starts a `deferred` queue
  row: the autoscaler never releases or launches one. An Alpha whose objective
  a deferred row waits on sends you
  `Release deferred <code>: <objective> delivered at <sha>` once its delivery
  lands, then waits for your reply before it reports done. Answer every such
  request, the same tick, one of two ways: release the row with
  `throne release-deferred --objective-code <code> --requested-by <agent> --reason "<text>"`,
  which sends the requester `Released <code>: <reason>` itself, or refuse with
  `throne send-agent <agent> "<why the row stays held>"`. The no-idling sweep
  also pings you about deferred rows, at most once an hour per row and reason:
  when every objective a row waits on is done, when one it waits on is
  abandoned or missing, and when the row has been held over 24 hours. Act on
  each ping: release the row, abandon it
  (`update-queue --status abandoned`), or say why the hold stands by
  re-deferring it with a new `--defer-reason`. A ping left unanswered comes
  back the next hour; no deferral lasts forever.
- **The Regent writes the Lord's page when it abandons, defers or releases a
  row.** Each of those changes where a piece of work stands, and no Alpha is
  alive to say so. Correct or move the row's entry on the where-i-stand page
  with `throne where-i-stand put`, keeping the page's entry form, and add a
  note with
  `throne where-i-stand note`: an abandoned row's entry says it was abandoned
  and leaves the page a day later; a deferred row's entry sits under
  `## Queued and deferred` and names what it waits on; a released row's
  entry stops saying it is held.
- **A throttle advisory lasts only as long as the nudge that carried it.** The
  keep-going heartbeat may end with a usage advisory such as "pace to ≤5
  concurrent Alphas". It describes the band evaluated for THAT nudge; a later
  nudge without it withdraws it. It is never a standing ceiling and never
  outranks `src/alpha-autoscale/alpha-autoscale-bounds.ts` (floor 5, ceiling
  7, hard maximum 8), whose floor constant the advisory now reads. On
  2026-09-21 the Regent was still holding launches to two Alphas on the
  strength of nudges from 2026-09-18.
- **The autoscaler has no spawn cooldown; pressure paces it.** One tick
  launches Alphas back to back until a gate refuses (kill switch, pressure
  verdict, capacity, no eligible row) or its launch budget is spent. The
  budget is read once per tick from pressure, assuming each launch adds 20
  points, with a floor of one launch while pressure is below the
  take-more-work line `AT_CAPACITY_THRESHOLD`:
  `max(floor((80 - pressure) / 20), pressure < AT_CAPACITY_THRESHOLD ? 1 : 0)`,
  so pressure 0 launches up to 4, pressure 40 up to 2, 60, 65 and 69.9 one,
  and 70 or above nothing, matching `throne resource-pressure`
  (`alphaLaunchBudgetForPressure` in `alpha-autoscale-bounds.ts`). The Lord
  removed the five-minute cooldown on 2026-09-23.
- **Record every full-suite hold and release.** Whenever the Regent holds a
  campaign for full-suite access or releases one, it calls
  `record-suite-hold --campaign <name> --reason <why>` or
  `record-suite-release --campaign <name>` (`src/regent-fencing/`) at the
  moment of the hold or release, not after the fact. This is the durable
  arbitration ledger a successor reads if the Regent goes down mid-sequence —
  an unrecorded hold is invisible to whoever inherits the sequencing.
