# 🔴 STAGER — rename the Planner role to Stager; fix its charter text
LORD ORDER (via planner-queue-triage-2): "something wrong with the initial
messaging for creating a planner agent. you are my staging agent, as well as
act as a 'messenger' between me and regent. maybe we need to rename you as
the stager. ok let's do that. the reason why I need you to be the messenger
is because sometimes regent is way too busy... i.e. in create-agent, you are
now a stager."

WHAT: rename the `Planner` role to `Stager` everywhere it is a role identity,
not merely a display label — `create-agent --role`, the durable identity/role
casing, the opening-prompt/charter text, admission policy, model-registry
pools, no-idling and keep-going stall handling that special-case the role.
The charter text itself (identity-data.service.ts's `ROLE_STANDING_INSTRUCTION`
entry, currently keyed `Planner`) should also be reviewed/tightened per the
Lord's framing: the role exists explicitly so Regent load never blocks the
Lord reaching someone — the "why" (Regent gets too busy) should be legible in
the charter text itself, not just implied by the relay mechanic.

SITES FOUND (grep for `"Planner"` / `Planner` as a role token, verify against
tree before trusting this list — it is a planner-side grep, not a landed
audit):
    src/config.ts
    src/agentdata/identity-data.service.ts (+ .spec.ts)
    src/harness-routing/model-registry.ts (+ .spec.ts)
    src/harness-routing/policy/admission.ts (+ .spec.ts)
    src/no-idling/idle-family.ts (+ .spec.ts)
    src/no-idling/stale-tab-report.ts
    src/no-idling/no-idling-run.test.ts
    src/keep-going/keep-going-stalls.ts (+ .test.ts)
    src/shared-policy/identity-role-casing.ts
    src/create-agent/request.test.ts
    src/slice-evidence/agent-evidence-gate.test.ts
    src/planner-queue-append/planner-queue-append.ts (+ .test.ts) — directory
    name itself references the old role name; decide whether the module dir
    is renamed too or kept as an internal name while the role token changes.

CONSTRAINTS:
  - This is a role-identity rename, not a cosmetic string swap: `roleNameFor`
    prefixes worktree/agent names with the lowercased role
    (`planner-<name>` today) — decide and state explicitly whether existing
    live `planner-*` agents (e.g. this very agent, `planner-queue-triage-2`)
    get migrated, left as legacy, or grandfathered, and whether newly created
    agents get a `stager-` prefix from this point forward.
  - `canonicalizeIdentityRole` in `identity-role-casing.ts` is the
    single source of truth for accepted spellings — case handling for
    `--role stager`/`Stager`/`STAGER` must land there, not be reinvented at
    a call site.
  - Full-suite `npm test` and `npm run typecheck` must pass; this touches
    admission gates and stall detection, both safety-relevant.

NOT YET DECIDED (Alpha should research and decide, not ask the Lord):
  - Whether `PLANNER_ASK_ADDRESSEE_INSTRUCTION` and its constant name change
    too, and whether any other role-named constant needs a matching rename
