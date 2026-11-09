# herdr-update: rehearsing a herdr release before it is trusted

This capability downloads a herdr release beside the pinned copy, verifies
its hash against real GitHub release metadata, launches it under an isolated
session, exercises the read-only herdr-dependent command surface against it,
re-reads its live-reported protocol, and tears the isolated session down. It
never moves `OWNED_HERDR_CLIENT_RELEASE_TAG` or `THRONE_HERDR_PROTOCOL` and
never touches the live `throne` session, `herdr-server.service`, or
`throne-work.service`.

## `throne-work` and a second herdr session

A second, isolated herdr session for testing does **not** need its own
`throne-work` instance. `throne-work`'s entire job is sending keep-going /
no-idling nudges into live agent panes it observes inside the one session it
is bound to. An isolated rehearsal session started by this capability has no
throne agent panes in it — nothing for a second `throne-work` to observe or
act on. `throne-work` is therefore **irrelevant to**, not blocked by, a
second session: this capability exercises herdr commands directly against
the isolated session's server process and never needs, starts, or coordinates
with any `throne-work` instance. This reasoning is recorded here so a future
reader rehearsing a real upgrade does not have to re-derive it under
pressure.

## Performing a real upgrade: `scripts/herdr-upgrade.mjs`

    node scripts/herdr-upgrade.mjs --check
    node scripts/herdr-upgrade.mjs v0.8.3 --dry-run
    node scripts/herdr-upgrade.mjs v0.8.3 --yes --restart-ordered-by-lord "<the Lord's words, verbatim>"
    node scripts/herdr-upgrade.mjs --pinned --dry-run
    node scripts/herdr-upgrade.mjs --pinned --restart-ordered-by-lord "<the Lord's words, verbatim>"

Ten phases, each verified before the next. Written after doing v0.8.0 ->
v0.8.2 by hand on 2026-08-24; every guard in it exists because that run hit
the thing it guards against. Run `--dry-run` first — it performs the real
rehearsal (network, hash check, isolated session) and stops short of any
mutation. `--check` takes no tag and mutates nothing: it reports the pinned
tag and protocol, the tags installed under the owned herdr home, the live
`throne` server's version and protocol, the throne CLI's, `bin/herdr`'s and the
running service's herdr versions side by side, and the latest release. A
mismatch between those versions is a `FAILED:` line and a non-zero exit.

A tag that is already installed can be applied. A dry run never refuses it, and
an apply leaves the binary in place when it already has the rehearsed hash, so
re-applying the current tag restarts the service and brings the court back with
no new release.

A real run restarts herdr, the bot server, its bridges and the backend, so it refuses in preflight, before
anything changes, unless `--restart-ordered-by-lord` carries the Lord's own
words ordering that restart; `--yes` never stands in for them. A dry run needs
no word and lists live campaign agents instead of refusing them.

| # | Phase | Why it is here |
| - | ----- | -------------- |
| 1 | preflight | Refuses a tree dirty outside the two pin files (a run that stopped after phase 4 re-runs), live campaign agents, a real run without the Lord's words, and an apply of an installed tag without `--yes`. |
| 2 | rehearse | `rehearseHerdrUpdate`; requires hash match and a clean sweep. |
| 3 | install | Hash-verified artifact only, alongside the old version. A file already holding the rehearsed hash is left alone, because the running server's binary cannot be written over. |
| 4 | pins | Both pin sites, digests from real release metadata. Committed at the end of phase 7. |
| 5 | identity snapshot | **Before** the mismatch window opens. |
| 6 | build | Opens the client/server mismatch window. |
| 7 | unit | `install-services` re-renders the unit (Linux: ExecStart via `systemctl --user cat`; macOS: the `com.throne.throne-herdr` LaunchAgent plist must name the new binary); restarts nothing. Moved pins then land as one `Pin herdr to <tag>` commit, pushed when `throne.yolo` is true; unchanged pins make no commit. A refused push is a `FAILED:` line and a non-zero exit, the commit is kept, the apply carries on, and the next apply pushes that commit again. |
| 8 | restart | Detached (Linux: `systemd-run` transient unit, outside the herdr unit's cgroup; macOS: its own session): `scripts/herdr-repair-identities.mjs` takes the resurrect lock, then runs herdr, the bot server, the bot bridges, then `throne-backend`. Linux: a `gpg-agent` inside either herdr unit first moves to its own scope, see "The signing agent"; then `systemctl --user restart` on the herdr and backend units, and `systemctl --user try-restart` on `throne-bot-herdr.service` and then `throne-bot-bridge@*.service`, so a host without them running is not a failure, and one that fails writes a `FAILED:` line and does not stop the run; when that unit is active its server is verified too, and a `FAILED:` line there does not stop the run. macOS has no bot server. macOS: `launchctl kickstart -k` would relaunch the job launchd cached at bootstrap, still the old binary, so the herdr agent is booted out, the script waits until `launchctl print` no longer finds it, bootstraps the rewritten plist (retrying while launchd refuses), and confirms the loaded job names the new binary; never bootstrap before launchd confirms the bootout. The backend's plist does not change, so it gets `launchctl kickstart -k` once the new server answers. |
| 9 | resume and identity repair | `scripts/herdr-repair-identities.mjs` relaunches every snapshotted agent the restart ended into its own session in its own tab under its own name, the Regent last, under the same hold of the resurrect lock, kept fresh throughout. Each agent gets an outcome line. |
| 10 | verify | The restarted server must answer with the target version, or the restart writes a `FAILED:` line and stops before the backend; then the roster, and last the throne CLI's, `bin/herdr`'s and the running service's versions side by side, `FAILED:` prefixed on a mismatch. |

Every line the script prints lands in `~/tmp/herdr-upgrade.log`; each run
opens with a header line naming the mode, tag and time.

## Catching up to the pin: `--pinned`

The tag form moves the pin to a release. `--pinned` is the opposite direction:
the pin already moved in a pull, and the machine catches up to it. The target is
the tag `src/herdr/herdr-client.ts` pins, so it takes no tag, and the caller has
already built.

When the throne CLI, `bin/herdr` and the running service all report the pin, it
prints the versions line and exits 0: nothing restarts and no word is needed. A
disagreement between any of them is not at the pin, even when two of them match
it.

`bin/herdr` runs the highest release installed, not the pin. So when only it is
off the pin, with the CLI and the running service at the pin, a restart cannot
help: the run refuses even with the word, restarts nothing, and says to remove
the release above the pin. Without this refusal every run with the word would end
every agent and change nothing.

Otherwise it runs phases 1, 5, 7 and 8-10 from the table, through the same code
as the tag form. It skips the rehearsal, the pin move, the build and the pin
commit, so it needs neither `bin/gh` nor release metadata: `install-services`
installs the pinned binary and checks its hash against `HERDR_RELEASE`. Phase 1
refuses a real run without the Lord's words as it always does; an installed
pinned binary is the normal case here, so that one refusal does not apply.

Phase 5 takes its binary from the version the running server reports, never from
the rendered unit, because a caller may already have run `install-services` and
left the unit naming the new tag while the old server still runs. Measured on
2026-11-07 on throwaway sessions with v0.8.2 and v0.9.5: `status server --json`
reads across the protocol gap in both directions and reports the server's real
version, and `agent list` fails `protocol_mismatch` in both. So any installed
binary can name the running version, and only that version's binary can read the
agents. When that binary is missing, or no binary can read the version, the run
refuses before anything changes. A stopped server has nothing to snapshot, so the
run goes on and the restart starts it.

## The five traps this replaces

**1. Always pass `--session throne`.** A stray sessionless herdr daemon can
outlive everything (observed: a brew 0.8.0 server alive five days on
`~/.config/herdr/herdr.sock`). It answers `status server` with a *different*
version, and on 2026-08-24 that made a completely successful upgrade read as
a total failure in the log. Never query herdr without `--session` during an
upgrade.

**2. Never install the package manager's binary.** Homebrew's 0.8.2 was not
byte-identical to the GitHub release artifact (`450cb7b1…` vs `976150a1…`).
Matching version strings do not imply matching bytes. Only the hash-verified
download is trusted.

**3. There are TWO pins, and they named two repositories.**
`OWNED_HERDR_CLIENT_RELEASE_TAG` + `THRONE_HERDR_PROTOCOL` in
`src/herdr/herdr-client.ts`, and `HERDR_RELEASE` in
`src/install-services/herdr-release.service.ts` — the latter still pointed at
the pre-migration `ogulcancelik/herdr` while `herdr-update-release.ts` used
`herdrdev/herdr`. Read the protocol from the new binary's own
`status server --json` inside the rehearsal, never from the mismatch error
text; and take every digest from release metadata, because a previous move of
that constant shipped fabricated checksums.

**4. The mismatch window is self-inflicted and total.** Between the build and
the restart, the client speaks the new protocol and the server the old one, so
*every* throne herdr call fails `protocol_mismatch`. Do not start with live
campaigns running, and keep the window short.

**5. Restarting herdr alone is not enough.** The restart ends every harness,
so the court has to be relaunched (phase 9), and `throne-bot-herdr.service`
serves its own session and would stay on the old protocol, which is what
happened on 2026-10-18. `throne-backend` is a
separate service (its own cgroup on Linux, its own LaunchAgent on macOS). It survives the herdr restart still running
the OLD `dist/` in memory, believing the previous protocol and binary path —
while hosting the only cron that resurrects the Regent. Restart it after
herdr is healthy or nothing can bring the court back.

## What the restart actually does to agents

A restart ends every pane process, on Linux and on macOS. Measured on a
throwaway session on 2026-11-06 with herdr 0.9.5: a foreground process died on
`systemctl --user restart`, and the pane and tab came back under their old ids
with a fresh shell. herdr's own session-state page says the same. The throne
sets `resume_agents_on_restore = false`, so herdr brings no harness back, and a
restart needs the Lord's word. The agent that ran the apply loses its own pane.

Phase 9 brings the court back through the same per-agent relaunch
`restart-harnesses` uses, with nothing to stop first. The Regent goes last, and
one process takes the resurrect lock before the service restarts and holds it
until the Regent is relaunched. Court-liveness ticks every minute and asks for a
resurrection on its first tick after a boot, so without the lock the real Regent
could be seated on the empty roster, and its reconciliation reaps a registered
agent that is absent and has no resumable work. Each agent can wait 45 seconds on
its composer, so a resume can outlast the lock's five minute stale age; a timer
refreshes the lock every minute while it runs.

Three more things keep a half-resumed court safe. A relaunched harness in the
live root boots with no herdr name and no Regent present, so `throne-startup`
declines the Regent's name when `THRONE_AGENT_NAME` names anyone else. The
every-minute agent revival skips while the lock is held, or it would start a
harness in a pane the resume is about to use. Court-liveness's Stager revival
needs a live Regent, so it cannot run until the resume has finished.

If the restart stops at a `FAILED:` line, nobody is resumed and the lock is
released at once, so the tail still prints the roster and the versions. The
court is then down: the watchdog resurrects the Regent if the server answers,
and that Regent's reconciliation runs against an empty roster, so an idle Stager
can be reaped. Read the `FAILED:` line before anything else. A tail killed
outright leaves the lock to go stale after five minutes.

The closing check is that each name sits on a pane with a live harness. A
session id that differs after a resume is not a failure.

The restart also destroys **agent name registration**, which is server-side
state. With the names gone the boot ritual finds no named Regent and renames the
FIRST AVAILABLE pane to `regent`. On 2026-08-24 that was the Stager's pane,
and the real codex Regent was left unnamed — unable to send, unable to receive
an escalation, unable to be resurrected by name. Phase 5 plus phase 9 exist so
it repairs itself.

For a pane that still holds a snapshotted session,
`herdr-repair-identities.mjs` resolves ownership by `agent_session.value`
alone — the harness's own session id — never by pane order or availability. It
parks squatters onto `stale-*` names *before*
claiming, because renaming into a still-held name fails `agent_name_taken`,
and the intuitive repair order (fix the Regent first) is exactly the order
that hits it.

## The signing agent

A `gpg-agent` that a signing call started from a pane lives in the herdr unit's
cgroup, so a restart of that unit ends it and its cached passphrase, and every
signed commit then waits for the Lord to type it again. On Linux the first
restart step moves any `gpg-agent` inside `throne-herdr.service` or
`throne-bot-herdr.service` into a transient `throne-gpg-agent-<pid>.scope`, with
`StartTransientUnit` and a `PIDs` property, and the process and its cache carry
on untouched. `StartTransientUnit` returns before the process has moved, so the
step waits until `ps` shows it in the scope. Measured on 2026-11-07 on a
throwaway agent in a throwaway unit: the moved agent survived the unit's restart
and signed with no passphrase offered, an unmoved agent died, and a fresh agent
refused that signature.

An agent already outside those units, or no agent, leaves nothing to do and the
log says so. A move that fails prints a `FAILED:` line saying signing will need
the passphrase after the restart, and the restart still runs. macOS has no
cgroup and no such step.

## Retirement criteria (herdr)

Per the migration law in `AGENTS.md` (replacement ships alongside what it
replaces; retirement criteria defined before starting), the old herdr binary
at `ownedHerdrExecutablePath()` for the currently pinned tag stays on disk
— it is never deleted as part of adopting a new tag — until **all** of the
following hold:

1. A new herdr binary has been rehearsed through this exact capability
   (`rehearseHerdrUpdate`) end to end: download hash-verified against real
   GitHub release metadata, isolated session launched, and every command in
   the read-only command sweep reporting `succeeded: true`.
2. That same rehearsal's protocol comparison (`compareLiveProtocolToPinned`)
   reports `matches: true` against the (now-updated) pinned
   `THRONE_HERDR_PROTOCOL` — confirmed from the new binary's own live output,
   never hand-edited from assumption.
3. The new binary has then run live, as the actual `OWNED_HERDR_CLIENT_RELEASE_TAG`,
   for an Alpha-judged bake period with none of the failure modes the
   rehearsal was built to catch (version mismatch, protocol mismatch, hash
   rejection, command-sweep failure) observed in real use.

Only once all three hold may the old tag's local copy under
`ownedHerdrExecutablePath()` be removed. Until then it is left in place —
retiring it earlier means the fallback a broken new binary would need is
already gone.
