# Fresh-spawn harness-routing audit (CHR slice 01)

Date: 2026-08-25. Scope: trace the 2026-08-24 OmpAll evidence and state the
legacy `create-agent-legacy` compatibility requirement for the fresh-spawn
harness-selection correction.

## Historical OMP evidence

The historical claim is too broad. Commit `8b52b819` added
`test/omp-custom-preset-routes-real-launcher.test.ts`. Its one test,
`a config.user.ts preset selecting the omp harness routes a real spawn to the
omp launcher`, does **not** invoke `create-agent`, `prepareCreateAgentRequest`,
or `resolveSpawnPolicy`.

It validates an isolated in-memory `OmpProofPreset`, confirms its
`omp/sonnet` pool pair is in `CONFIGURED_MODEL_PAIRS`, and directly calls
`buildLaunchArgv({ harness: 'omp', model: 'sonnet', effort: 1 })`. The passing
assertion proves that an already-selected OMP pair produces the `bin/ompy`
argv. It does not prove that a fresh `create-agent --model sonnet` request
selects that pair from the role pool. Re-running the preserved test in this
worktree with `THRONE_LIVE_ROOT=<the live throne checkout>` passed.

The campaign also recorded a real OMP pane, but it is separate infrastructure
evidence: its report says a pinned Herdr `tab create` followed by `pane run`
executed `bin/ompy` directly. The ledger confirms `shadow-omp-07` itself was
registered as `claude/sonnet` (`spawn.json`), and its `sent-messages.jsonl`
contains a message to the separately named `omp-proof-07`. That demonstrates
the direct pane could run OMP; it is not evidence that `create-agent` routed a
fresh role-pool request to OMP.

## Current fresh-path failure

`prepareCreateAgentRequest` resolves `--model opus` through
`resolveRegistryModel`, yielding the registry-primary `claude/opus` pair.
`resolveSpawnAdmission` then calls `canonicalForwardModelPair` and only checks
that already-derived pair against the pool. Consequently an OMP-only role pool
rejects `claude/opus`; it never supplies its permitted `omp/opus` pair.

## Legacy twin compatibility

Slice 02 must change `create-agent-legacy` as well as `create-agent`, unless
the legacy command is explicitly retired from fresh spawning (it is not today).
Its policy currently canonicalizes the request before its first
`planRolePoolRefusal`, so an OMP-only pool rejects `claude/opus` before legacy
steering runs. Its later final-pair check repeats the same mismatch.

Use the shared `resolveSpawnAdmission` reconciliation at legacy's initial
fresh-pair admission point, before `steerSpawn`, and pass its admitted pair
through existing effort/steering/final-pool logic. For the non-GPT OMP/opus
case this makes legacy's existing steering launch the selected pair and keeps
the registered-resume branch untouched. The implementation must also preserve
the campaign contract for GPT pairs: a valid pool-selected harness must not be
silently rewritten back to the registry-primary harness by either command's
later canonicalization or final-pair check. Add the same integration coverage
for both command paths, with a temporary in-process OMP pool; do not enable
OMP in live `config.user.ts` or run a real spawned-agent E2E test.
