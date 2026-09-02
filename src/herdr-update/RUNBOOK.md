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

    node scripts/herdr-upgrade.mjs v0.8.3 [--dry-run] [--yes]

Ten phases, each verified before the next. Written after doing v0.8.0 ->
v0.8.2 by hand on 2026-08-24; every guard in it exists because that run hit
the thing it guards against. Run `--dry-run` first — it performs the real
rehearsal (network, hash check, isolated session) and stops short of any
mutation.

| # | Phase | Why it is here |
| - | ----- | -------------- |
| 1 | preflight | Refuses a dirty tree and refuses live campaign agents. |
| 2 | rehearse | `rehearseHerdrUpdate`; requires hash match and a clean sweep. |
| 3 | install | Hash-verified artifact only, alongside the old version. |
| 4 | pins | Both pin sites, digests from real release metadata. |
| 5 | identity snapshot | **Before** the mismatch window opens. |
| 6 | build | Opens the client/server mismatch window. |
| 7 | unit | `install-services` re-renders ExecStart; restarts nothing. |
| 8 | restart | Detached transient unit: herdr, then `throne-backend`. |
| 9 | identity repair | `scripts/herdr-repair-identities.mjs`. |
| 10 | verify | Server status, roster, end-to-end CLI. |

Output lands in `~/tmp/herdr-upgrade.log`.

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

**5. Restarting herdr alone is not enough.** `throne-backend.service` is a
separate unit in its own cgroup. It survives the herdr restart still running
the OLD `dist/` in memory, believing the previous protocol and binary path —
while hosting the only cron that resurrects the Regent. Restart it after
herdr is healthy or nothing can bring the court back.

## What the restart actually does to agents

It does **not** kill panes. That was predicted with confidence from the
process tree (`herdr` is the parent of every pane shell) plus
`KillMode=control-group`, and the prediction was wrong — every pane survived,
including the one that fired the restart. herdr advertises
`detached_server_daemon: true`.

What it destroys is **agent name registration**, which is server-side state.
With the names gone the boot ritual finds no named Regent and renames the
FIRST AVAILABLE pane to `regent`. On 2026-08-24 that was the Stager's pane,
and the real codex Regent was left unnamed — unable to send, unable to receive
an escalation, unable to be resurrected by name. This is the same failure seen
at 11:44 that day after a `brew` upgrade restarted the server; phase 5 plus
phase 9 exist so it repairs itself.

`herdr-repair-identities.mjs` resolves ownership by `agent_session.value`
alone — the harness's own session id, stable across the restart — never by
pane order or availability. It parks squatters onto `stale-*` names *before*
claiming, because renaming into a still-held name fails `agent_name_taken`,
and the intuitive repair order (fix the Regent first) is exactly the order
that hits it.

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
