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
2. Read the strict feature file at `${XDG_CONFIG_HOME:-$HOME/.config}/throne/features.json`.
3. Treat missing or false `harness-decouple` as OFF. Run the requested script command anyway so the canonical gate produces the no-action result; do not perform any separate release query or filesystem preparation first.
4. Stop on malformed feature data. Do not repair or reinterpret it.
5. Never update or restart Herdr. Treat Herdr as eligible for separate planning only when both `shouldOwnHarnessUpdates()` and `shouldUpdateHerdrInHarnessUpdate()` return true.

## Workflow

Process Claude and Codex serially. Never run two harness transactions concurrently.

Run a non-mutating release check:

```bash
node <skill-dir>/scripts/update-harness.mjs check \
  --harness claude \
  --throne-root <live-throne-root>
```

Run an isolated stage, probe, and atomic promotion:

```bash
node <skill-dir>/scripts/update-harness.mjs update \
  --harness claude \
  --throne-root <live-throne-root>
```

Use `--harness codex` for Codex. The updater obtains `@anthropic-ai/claude-code` or `@openai/codex` metadata from the authoritative npm registry, requires matching package identity, registry-hosted tarball provenance, and SHA-512 integrity, then extracts outside active paths. It probes version, help, auth/login help, resume, remote/cloud help, the matching `claudey`/`codexy` launcher with a staged-binary override, and hermetic throne launcher/create-agent/stored-resume tests. None of these probes may create a live agent, authenticate, mutate a remote session, touch Herdr, or mutate GitHub.

Promotion replaces only the harness `current` symlink after every probe passes. It preserves the immediately prior target as `previous`. Configure `CLAUDE_BIN` or `CODEX_BIN` to the `activeBinary` path in the emitted evidence record; do not replace launcher architecture or PATH packages.

**This managed tree is not on the live agent-resolution path today.** `~/.local/share/throne/harnesses/` is not on `PATH`, and the throne's own `claudey`/`codexy` launchers resolve the real binary via `yolo_resolve_real_bin` (`bin/agent-launcher-lib.sh`), which consults `$CLAUDE_BIN`/`$CODEX_BIN` or a `PATH` walk only — it has no knowledge of this managed tree. Promoting through this mechanism as written changes nothing about what agents actually execute. The real, live update path for each harness is its own native mechanism: Claude Code self-manages a versioned install under `~/.local/share/claude/versions/` (with its own `claude update|upgrade` subcommand and built-in rollback via the `current` symlink) and Codex is installed via its platform package manager (e.g. Homebrew's `codex` cask). This script's `check`/`update`/`rollback` remain correct and independently useful — for staging, probing (including a real send-agent-through-the-queue proof once the process-tree TS-loader propagation is set up, see `probeStagedHarness`), and integrity verification — but do not treat a `promote()` here as equivalent to updating the harness every agent runs on until the launchers are deliberately wired to consult it.

Roll back one harness:

```bash
node <skill-dir>/scripts/update-harness.mjs rollback \
  --harness claude \
  --throne-root <live-throne-root>
```

Rollback atomically swaps `current` and `previous` and performs no registry access.

## Evidence and reporting

Retain the JSON evidence path printed by the command. Report the old and new local CLI versions, registry package/tarball/integrity provenance, every probe, active and rollback paths, and whether dual flags make Herdr separately eligible. State explicitly that this workflow neither touched nor restarted Herdr and that hosted services and model behavior remain mutable independently of the pinned local CLI artifacts.

Do not claim success when any probe or integrity check fails. The prior `current` target remains active at that boundary.
