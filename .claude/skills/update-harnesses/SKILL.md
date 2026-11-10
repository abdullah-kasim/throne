---
name: update-harnesses
description: 'This throne-locally discovered skill checks, updates, pins, promotes, or rolls back throne-managed Claude Code and Codex CLI harness installations. Use for explicit harness release checks or changes. It runs only from the live throne or a throne worktree; it is not discovered globally.'
version: 1.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension update-harnesses` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Update Throne-Managed Harnesses

This skill is throne-local: it lives at `throne/.claude/skills/update-harnesses/`
and Claude Code discovers it natively from a throne cwd (live root or worktree).
It is deliberately not part of the machine's global skills tree (`~/.claude/skills`),
so it does not surface in unrelated repositories.

Use `scripts/update-harness.mjs` for every transaction. Do not reproduce its discovery, integrity, staging, probe, promotion, pin commit, or rollback logic. The agent's job is to run the commands below and read what they print; the script does the rest, and no step is done by hand.

## Preconditions

1. Locate the live throne root containing `vendor-pins.json`.
2. Run `check` first; its command is under Workflow. It reads the pin and the
   vendored binary's own `--version`. This pair — pinned and vendored — is the
   harness the court actually runs. `bin/claude`/`bin/codex` export
   `CLAUDE_BIN`/`CODEX_BIN` pointing at this same vendored binary, so no other
   resolution order reflects what agents execute.
3. Never update or restart Herdr from this skill. A herdr update goes through
   `/update-herdr`.

## Workflow

Process Claude and Codex serially. Never run two harness transactions concurrently.

Run a non-mutating release check. It resolves the pinned, vendored, native,
and registry-latest versions and states which one agents actually run:

```bash
node <skill-dir>/scripts/update-harness.mjs check \
  --harness claude \
  --throne-root <live-throne-root>
```

Run an isolated stage, probe, and atomic pin transaction:

```bash
node <skill-dir>/scripts/update-harness.mjs update \
  --harness claude \
  --throne-root <live-throne-root>
```

Use `--harness codex` for Codex. The updater obtains `@anthropic-ai/claude-code` or `@openai/codex` metadata from the authoritative npm registry, requires matching package identity, registry-hosted tarball provenance, and SHA-512 integrity, then extracts outside active paths. It probes version, help, auth/login help, resume, remote/cloud help, the matching `claudey`/`codexy` launcher with a staged-binary override, and the throne launcher test `test/ompy-launcher.test.ts`. Create-agent is not probed, and the evidence's `probes` field says so. None of these probes may create a live agent, authenticate, mutate a remote session, touch Herdr, or mutate GitHub.

For Claude, `--model-session-check` on `update` or `check` asks the binary which model id each of fable, opus, sonnet and haiku runs as, and an id the registry cannot resolve fails `update` (or is reported by `check`) naming `src/harness-routing/model-registry.ts`. It is off by default because the binary lists no model ids, so each alias costs one paid one-line session.

On a passing probe, `update` rewrites `vendor-pins.json` (preserving its
`_comment` array byte-for-byte) and `vendor/package.json` to the new version,
runs `npm install --prefix vendor`, refreshes the `install.sh` vendor stamp,
and reverifies the vendored binary's `--version`. It then lands the pin
itself: one `Pin <harness> to <version>` commit holding only
`vendor-pins.json`, on the checked-out branch, leaving any other work in the
checkout as it was, and pushed to `origin` when `throne.yolo` is true. It
prints the diff and one line saying what happened to the commit and the push.
On any probe or integrity failure, none of `vendor-pins.json`,
`vendor/package.json`, or the stamp are touched — the prior pin remains the
source of truth.

An `update` that finds the pin already at registry latest and the vendored
binary reporting it installs nothing. It still commits a pin an earlier run
left uncommitted, so running `update` again finishes a run that stopped, and
it commits nothing when there is nothing to land.

A refused push exits 1 with a `FAILED:` line on stderr. The commit stays on
the branch; report the line, because the pin has not reached `origin`. The next
`update` pushes that commit again, and exits 1 the same way if it is refused.

A run that died leaves its transaction lock behind. The next run takes it
over and says so on stderr; a lock whose owner is still running refuses.

`npm install --prefix vendor` rewrites files under `vendor/node_modules/`
that a resident agent's process may currently have open. `update` does not
refuse merely because agents are live: it refuses only when
`throne agent-statuses` itself cannot be read. A running agent keeps
executing the version it already loaded until it restarts; only a fresh
spawn picks up the newly vendored binary. Say so in the report rather than
blocking on it.

`~/.local/bin/claude` — Claude Code's own self-managed install under
`~/.local/share/claude/versions/` — is not managed by this skill at all. It
is read only as the "native" column in `check`'s report, for contrast
against the pinned/vendored versions the court runs; `update` and `rollback`
never touch it.

Go to the version the checkout pins, never the registry's newest:

```bash
node <skill-dir>/scripts/update-harness.mjs pinned \
  --harness claude \
  --throne-root <live-throne-root>
```

`pinned` takes its target from the checkout's `vendor-pins.json` and decides
from what the vendored binary reports. When `--version` already reports the
pin, it calls no npm, stages and probes nothing, and prints
`update-harness: <harness> unchanged at <version>`. Otherwise it fetches that
exact version's registry metadata, stages and probes it as `update` does,
installs it, refreshes the `install.sh` vendor stamp, and prints
`update-harness: <harness> moved from <old> to <new>`. `<old>` is `none` when
nothing is vendored or the vendored binary cannot report a version.

`pinned` moves no pin: it never commits or pushes, and `vendor-pins.json`
stays byte for byte as it was. It does not read `throne agent-statuses`, so it
works while the court cannot answer. On any probe or integrity failure it
exits 1 and leaves `vendor/` as it was. A run that stopped part way leaves a
binary that does not report the pin, so running `pinned` again finishes it.
Running agents keep the version they loaded, as after `update`.

Roll back one harness:

```bash
node <skill-dir>/scripts/update-harness.mjs rollback \
  --harness claude \
  --throne-root <live-throne-root> \
  --source-evidence <evidence json printed by the update>
```

Rollback restores the `oldVersion` recorded in that evidence and re-runs the
same `npm install --prefix vendor` — it is not a symlink swap and it does
access the registry to reinstall the prior version's tarball. It lands the
restored pin the same way `update` does.

## Evidence and reporting

Retain the JSON evidence path printed by the command. Its `pinCommit` field
records the commit and push results. Every report of `check`,
`update`, or `rollback` must include the four versions `check` prints, so an
`update` or `rollback` report runs `check` again afterwards:

| pinned | vendored (what agents run) | native (PATH, outside throne) | registry latest |
| --- | --- | --- | --- |

State in words which version agents actually run (the vendored one) and
never call the native PATH binary "the harness". An `update` report also
gives the evidence's `package`, `source`, `integrity` and `probes` fields;
`probes` is empty when `update` installed nothing. A `pinned` report gives the
line it printed and the evidence's `moved`, `oldVersion` and `newVersion`
fields, plus those four fields when `moved` is true. State explicitly that this
workflow neither touched nor restarted Herdr and that hosted services and
model behavior remain mutable independently of the pinned local CLI artifacts.

Do not claim success when any probe or integrity check fails. The prior pin
and vendored install remain active at that boundary.
