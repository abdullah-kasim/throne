# Runtime-model-proven launch migration

`create-agent` is the runtime-model-proven launch path. It preserves an explicit
model request, disables Claude automatic model switching, and requires observed
runtime-model evidence before task and verdict acceptance.

`create-agent-legacy` remains available as the separately named migration
fallback. It retains the previous steered model-selection behavior through its
own `src/create-agent-legacy/` request parser, registration and persistence
orchestration, policy engine, launch orchestration, prompt dispatch, contracts,
and custom-harness service. This duplication is deliberate: the fallback does
not import replacement pipeline helpers, so a regression in replacement input,
policy, registration, persistence, launch, or dispatch cannot hide it. A defect
in the legacy pipeline likewise cannot change `create-agent`'s explicit-model
behavior.

## Retirement criteria

Do not remove `create-agent-legacy` until all of these are recorded and reviewed:

1. Ten consecutive campaigns launched through `create-agent` complete with
   matching task and verdict runtime-model attestations and no fallback use.
2. A real or rehearsed requested-versus-observed mismatch and a missing-runtime-
   evidence case are each refused at both acceptance boundaries, with all four
   quarantine evidence records preserved and readable after refusal.
3. Native and CLIProxy-backed Claude launch smoke tests prove automatic model
   switching remains disabled, and an explicit model reaches both launchers
   verbatim.
4. A repository and operator-history audit finds no remaining caller of
   `create-agent-legacy` during those ten campaigns.
5. The Regent makes a deliberate retirement decision after reviewing the above
   evidence; elapsed time or the replacement merely existing is not sufficient.
