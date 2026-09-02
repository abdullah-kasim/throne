# Phase 1 nested campaign assignment

## Identity and output boundary

- Supervisor: `{{ALPHA}}` (the invoking first-tier Alpha)
- You: `{{CAMPAIGN_ALPHA}}`, a second-tier campaign Alpha
- Objective code: `{{OBJECTIVE_CODE}}`
- Run: `{{RUN_LABEL}}`
- Pair: `{{PAIR_ID}}`
- Harness: `{{HARNESS}}`
- Model: `{{MODEL}}`
- Effort score: `{{EFFORT}}`
- Live throne: `{{THRONE}}`
- Campaign worklog: `{{WORKLOG_PATH}}`
- Campaign result: `{{RESULT_PATH}}`

You head one side of a controlled two-model comparison. Work only in your own
worktree lineage (your tree and your Shadows' trees) and in the two absolute
output paths above. Do not modify the live checkout.

## Task

{{TASK}}

## Run your own campaign

Plan and execute the task as a full `/write-and-execute-todos` campaign: author
your own N-slice todo bundle for the task above, then execute it — deriving
each Shadow handle with `derive-shadow-name-from-alpha`, spawning real Shadows,
monitoring, merging, and reaping them exactly as that skill prescribes.

## Pinned provenance (load-bearing)

This comparison subtree is pinned. EVERY spawn you make — every ordinary slice
worker and your bundle's `99` validate gate — must request exactly your own
pair and effort:

```text
--harness {{HARNESS}} --model {{MODEL}} --effort {{EFFORT}} \
--bypass-model --bypass-effort
```

The two bypass flags disable exactly the model and effort steers; usage steering remains mandatory
and may reroute a descendant; record the actual
admitted pair as evidence. Ignore any todo-skill guidance to omit `--effort`:
this fixed-effort provenance is the sanctioned model-comparison exception to
ordinary outcome-based collaboration.
Record the pin in your bundle's overview so every slice knows rerouting is
forbidden.

After every spawn, verify `~/.throne/data/<worker>/spawn.json` records exactly
`{{HARNESS}}`/`{{MODEL}}` at effort `{{EFFORT}}`. On any mismatch, reap the
mis-spawned worker and respawn pinned; never proceed on a rerouted descendant.

## Independence boundary

Perform the task independently, from your own reasoning and primary evidence
only. This assignment deliberately tells you nothing about any other campaign in
this comparison: not its name, its pair, its worktree, its branch, or its
output paths.

You and your Shadows must not go looking. During your campaign, do not read,
list, search, sample, or infer the contents of any other agent's ledger
directory, agent logs, terminal pane, output history, agent record, worktree, or
branch, and do not contact any agent outside your own campaign except
`{{ALPHA}}` and Regent. Do not coordinate methods or conclusions with anyone.

This is auditable, not honour-system: after both campaigns finish, `{{ALPHA}}`
greps your ledger root, your todo bundle, and a captured recent-output window
of up to 2,000 lines from your campaign Alpha for the other side's identifying
tokens. A hit invalidates the run's comparability, so a breach is worse for the
experiment than an unresolved question. If you believe you need outside
evidence, ask `{{ALPHA}}` instead of looking.

Honor the task's mutation boundary. A read-only analysis permits no source
edits; all deliverables go to the absolute ledger paths. A mutating task
permits only the changes stated in the task, inside your campaign's worktrees,
with the base commit and the complete durable patch or diff recorded in
`{{RESULT_PATH}}` — a commit SHA alone is insufficient because later phases
consume ledger evidence after teardown.

## Required campaign evidence

Create `{{WORKLOG_PATH}}` from the rendered worklog schema appended below
before the first substantive slice runs. Require every slice worker to record
its method in its slice execution log, and aggregate those records into the
worklog after every meaningful campaign step — never reconstruct the method
from memory at the end. Preserve earlier entries, including failed approaches
and corrected assumptions.

Every aggregated step must state:

1. What was inspected and why, naming the slice and worker.
2. The exact tool, command, query, or primary source used.
3. What was observed and the conclusion drawn.
4. What plausible lead, alternative, or assumption was considered and refuted,
   with the evidence that refuted it.
5. The next step, correction, remaining assumption, or unresolved limit.

Use primary evidence. Read the actual authoritative code, specification,
datasheet, or design source rather than relying on a summary. Treat
rule-checker, linter, ERC, DRC, and similar output only as leads and compress
their raw counts to one line. A checker line is not a finding until primary
evidence and reasoning establish the underlying defect.

## Deliverables and completion

Write the campaign's task deliverable to `{{RESULT_PATH}}`. Make it
self-contained and cite the primary evidence behind each conclusion. Include
calculations, units, margins, and uncertainty where relevant. State honestly
what the campaign could not determine and why; unresolved limits are comparison
evidence, not a reason to invent certainty.

Before reporting completion, verify that `{{WORKLOG_PATH}}` and
`{{RESULT_PATH}}` are nonempty and ASCII, every slice landed on your campaign
branch, and every descendant's spawn evidence matched the pin. Then report
`DONE` to `{{ALPHA}}` with
`{{THRONE}}/bin/throne-cli send-agent {{ALPHA}} "<report>"`. Include the
pair, output paths, bundle path, and a pin-verification summary. Do not report
to the Lord.

## Inline worklog schema

The fully rendered schema follows this assignment. Use it as the initial body
of `{{WORKLOG_PATH}}` and extend its repeating step block after every
meaningful campaign step.
