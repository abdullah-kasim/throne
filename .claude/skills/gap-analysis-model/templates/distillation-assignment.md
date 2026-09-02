# Phase 2 stronger-model distillation assignment

## Identity and output boundary

- Supervisor: `{{ALPHA}}`
- Worker: `{{SHADOW_ADDR}}`
- Run: `{{RUN_LABEL}}`
- Distiller pair: `{{PAIR_ID}}` (the orchestrator's pair — the strongest in the
  experiment and not a comparison participant)
- Distiller harness: `{{HARNESS}}`
- Distiller model: `{{MODEL}}`
- Effort score: `{{EFFORT}}`

Pair A is `harness={{A_HARNESS}} model={{A_MODEL}}`:

- Campaign worklog: `{{A_WORKLOG_PATH}}`
- Campaign result: `{{A_RESULT_PATH}}`
- Guidance document: `{{A_OUTPUT_DIR}}/{{A_HARNESS}}-{{A_MODEL}}.md`

Pair B is `harness={{B_HARNESS}} model={{B_MODEL}}`:

- Campaign worklog: `{{B_WORKLOG_PATH}}`
- Campaign result: `{{B_RESULT_PATH}}`
- Guidance document: `{{B_OUTPUT_DIR}}/{{B_HARNESS}}-{{B_MODEL}}.md`

Each guidance directory is that pair's model-family directory inside your own
worktree. It reaches its published global location through `merge-git-tree`;
never write into the live checkout instead.

## Original task

{{TASK}}

## Evidence barrier

Read all four evidence files in full before editing. Also read each guidance
directory's README and every existing capability document for either pair. You
may additionally read the two campaign todo bundles named in your opening
instructions read-only to resolve a disputed method claim; cite any such check.
Compare the recorded methods and results directly — do not favor either
campaign automatically, and do not use model reputation or an unrecorded
recollection as evidence.

## Durable product

Create or refine exactly the two capability documents named above, one per
compared `(harness, model)` pair. Every document must show its exact identity in
visible metadata:

- `harness={{A_HARNESS}} model={{A_MODEL}}`
- `harness={{B_HARNESS}} model={{B_MODEL}}`

Use the rendered durable-document skeletons appended below. Characterize what
each pair's campaign reliably did and failed to do on this task class — both
method-level gaps (missing or weaker investigation steps, source quality,
calculations, refutations, evidence discipline, efficiency) and result-level
gaps (correct findings, missed findings, false positives, unsupported claims,
prioritization, deliverable quality) — and link method to outcome causally.
Cite run `{{RUN_LABEL}}` and the absolute ledger paths above. Label direct
observations as observed and broader conclusions as inference. Do not infer a
stable model trait from one omission without saying that the evidence is
single-run.

If a document already exists, preserve prior supported guidance and add or refine
the new run's evidence. Never clobber its history. Reconcile contradictions,
record changed confidence, and retain earlier run labels and citations. Do not
create a separate document per run.

The strategic output is executable guidance, not a neutral gap score or winner
announcement. Turn every stable useful method into an instruction the weaker or
less consistent pair can adopt on the same task class: when to apply it, the
steps to perform, the evidence to record, and the check that proves completion.
In the canonical comparison, this means translating fable practices into
instructions that codex `gpt-5.6-sol` can follow to approach fable-class quality
while using codex headroom.

## Reliability and completion

Write ASCII only. Work in checkpoint-sized Write/Edit operations at effort
`{{EFFORT}}`; do not attempt one giant streamed synthesis and do not use
ultracode. Change only the two guidance documents named above, make one focused
commit, and verify that:

1. Both pair documents exist and are nonempty.
2. Each contains its exact `harness=<value> model=<value>` tag.
3. All four evidence files are cited.
4. Observations and inference are separated.
5. The guidance contains concrete, adoptable steps rather than a scoreboard.
6. Every changed file is ASCII.
7. Every capability assertion in the resulting documents, including preserved
   claims from earlier runs, uses the appended `capability-claim` block, cites
   one of the four campaign artifacts, and quotes an exact single-line excerpt
   from it. Migrate older unstructured claims before publication.
8. The skill-owned `validate-claim-evidence.mjs` command from your opening
   instructions passes for both committed guidance documents.

Then report `DONE` to `{{ALPHA}}` with the live throne `dist/src/tools.js send-agent`
command identified in your opening instructions. Include the commit SHA, changed
documents, and verification summary. Do not merge and do not report to the Lord.
