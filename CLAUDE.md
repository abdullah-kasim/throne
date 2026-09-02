# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` before making changes. It is the authoritative operating contract for the Lord → Regent → Alpha → Shadow hierarchy, delegation boundaries, objective-coded campaign names, worktree isolation, and model-routing policy. In particular, agents never ask the Lord to resolve decisions: Alphas research and decide, while the Regent reports outcomes.

AGENTS.md is not self-contained: it repeatedly defers detail to `agent_docs/*.md` — `agent_docs/architecture.md` (durable law's second half), `agent_docs/MODEL_POLICY.md`, `agent_docs/commands.md`, and `agent_docs/rest-transport-migration.md` among them. Read the one the current task touches, not just AGENTS.md.

## Commands

Production executes compiled JavaScript from `dist/`; Node's native TypeScript
type stripping is a development convenience only and does not provide the
Nest decorator transform or runtime metadata. Build with `npm run build`, then
run `npm start` (or `node ./dist/src/tools.js <command>`).

```bash
# Run the compiled CLI (omit the command to print the complete command surface)
npm start -- <command>

# Static type checking
npm run typecheck

# Lint (eslint + the public-release private-reference backstop); both gate `npm test`
npm run lint
npm run lint:private-refs

# Full test suite
npm test

# Heavy real-infrastructure tests (canaries + real-systemd rollback proof).
# LORD'S DIRECT ORDER ONLY — no agent runs this or sets THRONE_HEAVY_TESTS
# on its own initiative. See AGENTS.md "Hard rules of the court".
npm run test:heavy

# Run one named test (bypasses the suite guards below — use `npm test` before calling work done)
node --test --test-name-pattern='durable ownership flags default OFF when the feature file is absent' test/featureflags.test.ts
```

`npm test` is not a bare `node --test`: it runs through `scripts/run-suite-container.mjs` inside a container under whichever OCI runtime the host has (docker, then podman; `THRONE_CONTAINER_RUNTIME` forces one), which enforces a `dist-staleness-guard` (a stale `dist/` fails the suite — rebuild) and a `herdr-tab-leak-guard` before and after the run (a leaked herdr tab fails it). The single-test form above skips all of that.

The Nest sources use legacy decorators with emitted design-time metadata. Do
not use native `./bin/throne-cli` as production evidence: it ignores this
tsconfig and cannot provide the decorator runtime contract.

## Architecture

`src/tools.ts` is a thin entrypoint into the Nest Commander application: every user-facing command is owned by a command module under `src/`. Those command modules compose shared domain modules rather than duplicating their policies.

Herdr responsibilities are owned by modules under `src/` and consumed directly by Nest Commander domains. Agent addressing is name-based and must resolve uniquely. Message delivery is serialized per recipient pane and uses harness-specific screen evidence so a resident human draft is never overwritten and an uncertain submission is never blindly resent.

Agent creation separates policy from effects. `src/config.ts` contains declarative model pools and steering data, while the Nest Commander harness-routing domains own fresh-spawn usage, capability, admission, and steering decisions. The `create-agent` command validates the result, persists identity and spawn evidence, then launches through `src/harness.ts`. Capability floors and role-pool admission remain hard gates outside the steering engine.

Campaign code always lives in external git worktrees under `~/.throne/worktrees/<repo-basename>/`, including campaigns that modify the throne itself. The Stager is the one role exempt: it works in the live main checkout and is never given a worktree (AGENTS.md, "The Stager"). The gitignored `data/<agent-name>/` ledger remains in the live throne checkout and records identity, spawn recipes, target-repository provenance, todo bundles, and recovery evidence. Shadows branch from their Alpha; completed slices merge into the Alpha branch before the campaign is merged once into its recorded target branch.

Systemd user timers only keep the Regent alive and deliver nudges. Durable ledger state, not process presence alone, drives startup reconciliation after a reboot.
