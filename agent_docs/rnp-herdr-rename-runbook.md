# RNP: `herdr-server.service` → `throne-herdr.service` cutover runbook

**Status: PREPARED, NOT EXECUTED.** This objective (`RNP`) is the prep work
only. Nobody performs the actual cutover without explicit Lord/Regent
authorization at the cutover instant — see `throne-herdr.service`'s own
header comment, which already states that condition.

## Why this is dangerous

Stopping the live herdr terminal-workspace server — under EITHER name —
drops every herdr pane, including every live agent's harness process and the
Regent's own. The court has lived this exact incident once already
(2026-08-11 13:42, `uninstall.sh --yes` stopped `herdr-server` and every
pane died). This runbook exists so the next time it happens, it happens on
purpose, on one command, and is reversible.

## What shipped with this objective

1. **`uninstall.sh`'s live-court guard now recognizes BOTH unit names.**
   Previously it hardcoded `herdr-server.service` — a rename without this fix
   would have made the guard silently stop firing (all tests green, no
   protection left). It now checks `HERDR_UNIT_NAMES=(herdr-server.service
   throne-herdr.service)` and treats either one being active as "the herdr
   server is live." `UNITS=` also gained `throne-herdr.service` so uninstall
   can tear down either name it finds installed. This recognizes both names
   deliberately during the transition window; drop the legacy name only once
   the rename has fully landed court-wide.

   **Proof the guard still fires**, without ever executing `uninstall.sh`
   (banned court-wide): `scripts/rnp-herdr-guard-proof.sh` re-implements the
   exact detection snippet from `uninstall.sh` verbatim, stubs `systemctl` to
   report first `herdr-server.service` then `throne-herdr.service` as the
   active unit, and asserts the guard resolves `herdr_server_active=1` and
   the correct `herdr_active_unit` in both cases. Ran clean:
   ```
   === case: legacy name active (active=herdr-server.service) ===
   herdr_server_active=1 herdr_active_unit=herdr-server.service
   PASS
   === case: renamed unit active (active=throne-herdr.service) ===
   herdr_server_active=1 herdr_active_unit=throne-herdr.service
   PASS
   all cases passed
   ```

2. **`scripts/rnp-herdr-cutover.sh`** — the exact cutover sequence, gated by
   its own live-agent guard (see below — added after Regent review, 2026-08-12).
3. ~~`scripts/rnp-herdr-revert.sh`~~ — **DELETED 2026-08-14. The revert path no
   longer exists and cannot be reinstated by this runbook.** The cutover is
   complete (`throne-herdr.service` active, `herdr-server.service` `not-found`),
   and campaign `ist` removed `herdr-server` from `install-services` altogether,
   so nothing can render that unit any more. A script that reinstalls a unit the
   installer has forgotten is worse than no script.
4. **This runbook**, including rehearsal evidence for the revert.

## The cutover script REFUSES a live court by default (Regent order, 2026-08-12)

The first version of this runbook put the "court must be empty" precondition
on the caller, in prose only. The Regent overruled that: EVD (`fd76d55`,
landed the same night) exists precisely because "the caller will remember"
is a documented failure mode in this court, not a design — it fails even
when the instruction is explicit and correctly understood. The Regent named
himself as evidence: the same night, while reviewing this campaign, he had
already called a stall on a working agent, relayed an unverified count as a
premise, and escalated an unverified theory — the exact kind of caller this
guard has to survive.

So `rnp-herdr-cutover.sh` now checks the court itself before touching
anything:

- **Detection, same shape as `uninstall.sh`'s live-court guard and for the
  same reason:** primary probe is `herdr --session throne pane list`,
  independent of `dist/` being current or of throne's own name mapping,
  since this runs precisely while things may be mid-teardown. It is parsed
  with real `JSON.parse` (`node -e`), not grep/sed — pane records nest a
  *second* `"agent"` key inside `agent_session`, which broke a first
  brace-splitting attempt and silently undercounted live panes. Fallback is
  `agent-statuses` (via `dist/src/tools.js`), used only when the primary
  probe cannot run at all.
- **Fail closed, not open.** If neither probe can run — herdr unreachable,
  `node` missing, JSON unparseable, `dist/` absent — the script refuses. It
  never treats "I couldn't check" as "the court must be empty." (`uninstall.sh`'s
  own guard failed *open* four separate ways before that was fixed; this
  does not repeat it, and the parser's own explicit nonzero exit on any
  parse failure is what keeps a malformed probe response from being
  mistaken for zero panes.)
- **A live court refuses** — prints every detected agent (best-effort
  identifier: pane id, since the raw pane-list probe carries no throne
  registry name), then exits nonzero without calling `systemctl` at all.
- **`--force` overrides, loudly.** It proceeds anyway, but first prints a
  `KILLING: <identifier>` line for every single agent it is about to drop —
  the same shape EVD gave `reap-agent --force`, for court-wide consistency.
- **An empty court proceeds** straight into the cutover sequence.

**Proof, both mandatory classes plus the two supporting properties, via
stubbed `herdr`/`systemctl` (never a real session or unit) in
`scripts/rnp-cutover-live-guard-proof.sh`:**

```
=== Case 1: live court (2 agent panes, one with a nested agent_session) -> REFUSED ===
PASS: live court refuses (exit=1)
  ok: reports exactly 2 agents (nested agent_session.agent must not be double-counted)
  ok: names pane w1:pA
  ok: names pane w1:pB
  ok: never touches systemctl

=== Case 2: empty court -> PROCEEDS ===
PASS: empty court proceeds (exit=0)
  ok: confirms zero live agents
  ok: reaches systemctl stop herdr-server
  ok: reaches systemctl enable --now throne-herdr

=== Case 3: probe unreadable -> FAILS CLOSED ===
PASS: unreadable probe fails closed (exit=1)
  ok: fails closed with explicit message
  ok: never touches systemctl

=== Case 4: live court + --force -> proceeds, loud-warns naming the kill ===
PASS: live court with --force proceeds and names the kill (exit=0)
  ok: loud-warns naming the specific agent about to die
  ok: reaches systemctl despite the live agent (force honored)

TOTAL: 4 passed, 0 failed
```

Also sanity-checked against the *real* live court (read-only up to the
refusal — the guard fires before any `systemctl` call runs): with the Regent
and two campaign Alphas live, `bash scripts/rnp-herdr-cutover.sh` correctly
detected all 3, named their panes, and exited 1 without touching any unit.

## The mechanical cutover

```bash
systemctl --user stop herdr-server.service
systemctl --user disable herdr-server.service
systemctl --user enable --now throne-herdr.service
```

`throne-herdr.service` is already installed and byte-identical in shape to
`herdr-server.service` (same `ExecStart`, same
`/usr/bin/bash -lc 'exec {{HERDR_BIN}} --session throne server'`), so this is
a like-for-like swap, not a behavior change.

## The mechanical revert

```bash
systemctl --user stop throne-herdr.service
systemctl --user disable throne-herdr.service
systemctl --user enable --now herdr-server.service
```

## Three questions, answered with evidence

### 1. Does the Regent survive its own rename?

**No.** `herdr-server.service` hosts every pane, including the Regent's. The
moment it stops, the Regent's process dies along with everything else. There
is no way around this — the cutover script therefore **must run detached**,
launched via `systemd-run --user` so it is supervised by the user's systemd
manager (a separate process tree from herdr and its panes) and keeps running
to completion after the launching pane is gone:

```bash
systemd-run --user --unit=throne-rnp-cutover \
  --description="herdr-server -> throne-herdr rename cutover" \
  /usr/bin/bash /path/to/throne/scripts/rnp-herdr-cutover.sh
```

Verify completion afterward with:

```bash
systemctl --user status throne-rnp-cutover.service --no-pager
journalctl --user -u throne-rnp-cutover.service --no-pager
```

### 2. What resurrects the Regent afterwards?

**There is no systemd timer left that does this.** The old
`throne-keep-going.timer` is retired. Resurrection is now
`KeepGoingHostedWorker`, a cron job living inside the still-running
`throne-backend.service` process (`src/throne-backend/keep-going.hosted-worker.ts`,
`cronExpression = CronExpression.EVERY_30_MINUTES` — fires at `:00` and
`:30`). **The court can sit Regent-less for up to 30 minutes** after the
cutover, because `throne-backend.service` is a separate unit from herdr and
is never touched by this cutover — it keeps running the whole time, but its
next resurrection tick may be up to 30 minutes away.

**Faster path, if wanted:** once `throne-herdr.service` is confirmed
`active`, an operator with a non-pane shell (ssh, physical tty — anything
that isn't itself a herdr pane, since none exist yet) can trigger
resurrection immediately instead of waiting for the half-hour mark:

```bash
node <throne root>/dist/src/tools.js keep-going
```

This is the same call the cron makes; running it by hand just doesn't wait
for the clock.

### 3. Do agent panes survive?

**Assume not.** Every herdr pane — agent harnesses included — dies with
`herdr-server`/`throne-herdr` regardless of which name is active. **The
Regent must ensure the court is empty of agents before triggering the
cutover.** Concretely: run `agent-statuses` and confirm no row reports
`LIVE`; if any campaign is mid-flight, let it land or park it first. This
precondition is the caller's job — `rnp-herdr-cutover.sh` does not check it
itself, because by the time the detached script is running, the decision to
proceed has already been made.

## Revert rehearsal (evidence, not folklore)

Rehearsed on **transient scratch units**, never the live `herdr-server`/
`throne-herdr` units, following the same method
`shadow-kgw-99d-validate` used. Two disposable, uniquely-named real unit
files (`throne-rnp-rehearsal-old.service` / `-new.service`, `sleep infinity`
payloads, clearly marked DISPOSABLE in their `Description=`) were installed
into `~/.config/systemd/user/`, enabled+started, then put through the exact
stop/disable/enable-now cutover-then-revert sequence and timed:

```
CUTOVER (stop old, disable old, enable --now new): 0.753s
REVERT  (stop new, disable new, enable --now old):  0.772s
```

Both transitions verified via `systemctl --user is-active` immediately after
(old inactive/new active post-cutover; old active/new inactive post-revert).
Cleanup: both scratch units stopped, disabled, their files removed,
`daemon-reload` + `reset-failed` run. Verified afterward: `systemctl --user
list-units 'throne-rnp*' --all` and `list-unit-files 'throne-rnp*'` both
report zero units — box left exactly as found. Real units confirmed
untouched throughout and after: `herdr-server.service`, `throne-backend.service`,
`throne-build.service`, `ntfy.service` all still `active`; `throne-herdr.service`
still `inactive` (unchanged from before the rehearsal).

**Why transient `systemd-run` units alone don't work for this rehearsal:**
first attempt used pure `systemd-run --user ... sleep infinity` transient
units. Stopping a transient unit garbage-collects its unit definition
entirely, so a subsequent `systemctl start <name>` fails with "Unit not
found." The real `herdr-server.service`/`throne-herdr.service` are
persistent installed unit *files* that survive being stopped, so the
rehearsal was redone with real (but disposable, obviously-named) unit files
to match production behavior — that second attempt is the timed evidence
above.

**Takeaway:** ~0.75-0.8s for either direction under rehearsal conditions.
Real cutover will differ slightly (`herdr` binary startup time, actual pane
teardown), but the systemctl-level mechanics are proven to work and revert
cleanly.

## Execution checklist (for whoever the Regent authorizes to run this)

1. Confirm Lord/Regent authorization for this specific cutover instant.
2. `agent-statuses` — confirm zero `LIVE` rows. If not empty, land or park
   every campaign first. (The script re-checks this itself via an
   independent probe — step 3 will refuse rather than proceed if this step
   was skipped or the court changed in between — but don't rely on that as
   the primary check; it's the backstop, not the plan.)
3. Launch cutover detached:
   ```bash
   systemd-run --user --unit=throne-rnp-cutover \
     --description="herdr-server -> throne-herdr rename cutover" \
     /usr/bin/bash /path/to/throne/scripts/rnp-herdr-cutover.sh
   ```
   If the court is not actually empty, this refuses (exit 1, no units
   touched) and names every agent it found — check `journalctl --user -u
   throne-rnp-cutover.service`, go empty the court, retry. Only pass `--force`
   as an extra argument if you deliberately mean to drop the named agents
   anyway; it loud-warns each one by name (`KILLING: ...`) before proceeding.
4. Every pane is now dead, including whichever pane ran step 3. Wait for the
   detached unit to finish (it will — it isn't itself a herdr pane):
   ```bash
   systemctl --user status throne-rnp-cutover.service --no-pager
   ```
5. Confirm `throne-herdr.service` is `active`.
6. Resurrect the Regent: either wait ≤30 min for `throne-backend`'s cron, or
   run `node <throne root>/dist/src/tools.js keep-going` by hand from a
   non-pane shell for an immediate resurrection.
7. **There is no revert.** (Historical: step 7 used to run
   `scripts/rnp-herdr-revert.sh`; deleted 2026-08-14 — see above.) If
   `throne-herdr.service` fails to come up, fix it forward: the unit template is
   `systemd/throne-herdr.service`, install it with `install-services`, and note
   that `throne-backend` `Wants=`/`After=` it but only for process start, not
   readiness — herdr has no `sd_notify` support, so ordering against it is
   best-effort by construction.
