---
name: update-harnesses
description: 'This throne-locally discovered skill checks, updates, pins, promotes, or rolls back throne-managed Claude Code and Codex CLI harness installations. Use for explicit harness release checks or changes only when durable throne harness ownership (`harness-decouple`) is enabled. It runs only from the live throne or a throne worktree; it is not discovered globally.'
version: 1.0.0
user-invocable: true
---

# Update Throne-Managed Harnesses

This skill is throne-local: it lives at `throne/.claude/skills/update-harnesses/`
and Claude Code discovers it natively from a throne cwd (live root or worktree).
It is deliberately not part of the global `claude/agent_docs/skills` tree, so it
does not surface in unrelated repositories.

Use `scripts/update-harness.mjs` for every transaction. Do not reproduce its discovery, integrity, staging, probe, promotion, or rollback logic.

## Preconditions

1. Locate the live throne root containing `src/shared-policy/feature-flags.service.ts`.
2. Read `vendor-pins.json`'s `harnesses.<h>.version` for the pin, then run the
   vendored binary's own `--version` (`$throneRoot/vendor/node_modules/.bin/<bin>
   --version`). This pair — pinned and vendored — is the harness the court
   actually runs; resolve it first, before touching PATH or any native
   install. `bin/claude`/`bin/codex` export `CLAUDE_BIN`/`CODEX_BIN` pointing
   at this same vendored binary, so no other resolution order reflects what
   agents execute.
3. Read the strict feature file at `${XDG_CONFIG_HOME:-$HOME/.config}/throne/features.json`.
4. Treat missing or false `harness-decouple` as OFF. Run the requested script command anyway so the canonical gate produces the no-action result; do not perform any separate release query or filesystem preparation first.
5. Stop on malformed feature data. Do not repair or reinterpret it.
6. Never update or restart Herdr. Treat Herdr as eligible for separate planning only when both `shouldOwnHarnessUpdates()` and `shouldUpdateHerdrInHarnessUpdate()` return true.

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

Use `--harness codex` for Codex. The updater obtains `@anthropic-ai/claude-code` or `@openai/codex` metadata from the authoritative npm registry, requires matching package identity, registry-hosted tarball provenance, and SHA-512 integrity, then extracts outside active paths. It probes version, help, auth/login help, resume, remote/cloud help, the matching `claudey`/`codexy` launcher with a staged-binary override, and hermetic throne launcher/create-agent tests that exist at HEAD. None of these probes may create a live agent, authenticate, mutate a remote session, touch Herdr, or mutate GitHub.

On a passing probe, `update` rewrites `vendor-pins.json` (preserving its
`_comment` array byte-for-byte) and `vendor/package.json` to the new version,
runs `npm install --prefix vendor`, refreshes the `install.sh` vendor stamp,
and reverifies the vendored binary's `--version` before printing the
resulting git diff for the caller to commit. On any probe or integrity
failure, none of `vendor-pins.json`, `vendor/package.json`, or the stamp are
touched — the prior pin remains the source of truth.

`npm install --prefix vendor` rewrites files under `vendor/node_modules/`
that a resident agent's process may currently have open. `update` does not
refuse merely because agents are live: it refuses only when
`throne agent-statuses` itself cannot be read. A running agent keeps
executing the version it already loaded until it restarts; only a fresh
spawn picks up the newly vendored binary. Document this in the transaction's
evidence rather than blocking on it.

`~/.local/bin/claude` — Claude Code's own self-managed install under
`~/.local/share/claude/versions/` — is not managed by this skill at all. It
is read only as the "native" column in `check`'s report, for contrast
against the pinned/vendored versions the court runs; `update` and `rollback`
never touch it.

Roll back one harness:

```bash
node <skill-dir>/scripts/update-harness.mjs rollback \
  --harness claude \
  --throne-root <live-throne-root>
```

Rollback restores the previous pin recorded in evidence and re-runs the same
`npm install --prefix vendor` — it is not a symlink swap and it does access
the registry to reinstall the prior version's tarball.

## Evidence and reporting

Retain the JSON evidence path printed by the command. Every report of `check`,
`update`, or `rollback` must include the four-version table `check` produces:

| pinned | vendored (what agents run) | native (PATH, outside throne) | registry latest |
| --- | --- | --- | --- |

State in words which version agents actually run (the vendored one) and
never call the native PATH binary "the harness". Also report registry
package/tarball/integrity provenance, every probe, and whether dual flags
make Herdr separately eligible. State explicitly that this workflow neither
touched nor restarted Herdr and that hosted services and model behavior
remain mutable independently of the pinned local CLI artifacts.

Do not claim success when any probe or integrity check fails. The prior pin
and vendored install remain active at that boundary.

When a transaction succeeds, close it out by committing exactly
`vendor-pins.json`, `vendor/package.json` and `vendor/package-lock.json` with
the message `Pin <harness> to <version>` — the Lord's own documented
procedure from `vendor-pins.json`'s `_comment` array. Do not invent a
different commit convention.
