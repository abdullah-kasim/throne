# 🔴 QFR ROOT MECHANISM — claims have NO LEASE and NO HEARTBEAT — 2026-08-11 ~15:08

Measured, not inferred. Item 330: created 14:02:51, `updated_at` **14:02:53**,
and it has not moved since — 65+ minutes, no `terminal_at`, no `failure_reason`,
`throne-work` journal empty for the window. Four others identical: claimed within
~2s, then frozen at their claim timestamp permanently. All five target codex
recipients; claude lanes delivered normally throughout, so the worker is alive
and healthy and only those lanes are wedged.

**`updated_at` is stamped once at claim and never again.** So an item being
actively worked is indistinguishable from one frozen for an hour, and nothing
observes the claim at all. That is *why* the row is eternal — not a deadline that
failed to fire. **Defect (4) is now proven rather than suspected.**

**Worse: a claimed item is orphaned by a worker restart.** No lease expiry means
no reclaim — unrecoverable without hand-editing SQLite. Same class as the reboot
problem TBK already solved for the Regent.

Handed to TBK as slice 06 requirements (BullMQ native `lockDuration`/
`stalledInterval`, plus a kill-worker-mid-job reclaim test). **Fourth live defect
class from this queue feeding that design** — eternal in-flight, 35 unexamined
failures, per-recipient head-of-line blocking, leaseless claims. One disease:
**the queue records states but observes nothing, so every failure ends in silence
rather than an error.**
## The fail-closed inversion (the reopen)
The first attempt shipped a guard that failed OPEN in four ways. The redelivery
inverts it: `live_confirmed_empty` starts at **0** and is set only by a probe
that actually succeeded, so *any* failure of *both* probes refuses
unconditionally, `--yes` included; only `--force-live-agents` overrides.

**The primary probe is now `herdr --session <name> pane list`, asked of herdr's
own server.** That is the right choice for reasons worth keeping: it is
independent of `dist/` (which `--purge` deletes — the vicious circle in the first
version) and independent of throne's own name mapping, **which is precisely what
desynced at 13:42 and made four LIVE agents read as DEAD**. `agent-statuses` is
retained only as a fallback when the primary cannot run at all. Counting
`"agent":` occurrences also catches *unnamed* panes, so the 13:42 condition is
covered rather than merely avoided.

**It caught its own contaminated verification.** Its first harness pass prepended
the scratch bin to the real PATH instead of replacing it, so `node` and `herdr`
were still reachable and the "blind path" tests were not blind at all. It noticed,
redid it with a genuinely isolated PATH, and reported the contamination unasked.
A verification that cannot fail proves nothing, and it found that in its own work.

Also folded in: **herdr-remote vendoring removed end to end** per the Lord's
cancellation (relayed via the other Regent pane) — `install.sh` git-vendoring
step, `uninstall.sh` shellout and config purge, `vendor-pins.json` pin.
`git grep -in herdr-remote` returns nothing, and `./install.sh` was **run for
real** end to end to confirm claude/codex still vendor correctly. Exercised, not
reasoned about. So HRR's campaign has been fully unwound by a later Lord order —
its findings survive in its archived REPORT.md.
