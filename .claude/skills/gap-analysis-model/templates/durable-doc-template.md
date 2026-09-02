# Capability guidance: {{CHARACTERIZED_HARNESS}} / {{CHARACTERIZED_MODEL}}

`harness={{CHARACTERIZED_HARNESS}} model={{CHARACTERIZED_MODEL}}`

- Task class: `{{TASK_CLASS}}`
- Contributing runs: `{{RUN_LABEL}}`
- Last refined by run: `{{RUN_LABEL}}`

When refining an existing document, add `{{RUN_LABEL}}` to the contributing runs
without removing earlier runs or their supported evidence.

## Evidence boundary

### Run {{RUN_LABEL}}

- Both campaign worklogs: `<absolute paths and relevant steps>`
- Both campaign results: `<absolute paths and relevant findings>`
- Observed behavior: `<what the four artifacts directly show>`
- Inference: `<what may generalize to this harness/model and why>`
- Confidence and limits: `<single-run limits, missing evidence, or conflicts>`

Keep observed behavior separate from inference. Cite both campaigns' evidence
for a cross-model claim and preserve disagreements that the primary evidence
does not resolve.

## Capability claim format

Write every capability assertion added or changed by this run in one or more
blocks with this exact shape. `evidence-file` must be one of the four admitted
campaign WORKLOG/RESULT paths. `evidence-text` must be an exact, single-line
excerpt from that file. Repeat the block when a statement needs evidence from
more than one artifact.

```markdown
<!-- capability-claim:start -->
statement: <one observed capability claim, or an inference explicitly labelled as inference>
evidence-file: <absolute WORKLOG.md or RESULT.md path>
evidence-text: <exact single-line excerpt from that file>
<!-- capability-claim:end -->
```

The claim-accuracy validator judges only whether this trace is concrete and
true. It does not judge prose style or subjective completeness. Unsupported
claims must be deleted or corrected, never dressed up as inference without an
observed premise.

## Reliable strengths

For each strength, state the trigger, recorded method, result benefit, and run
evidence. Do not use unsupported personality labels.

### <strength>

- Trigger:
- Recorded method:
- Result benefit:
- Evidence:
- Confidence across contributing runs:

## Characteristic gaps versus a stronger model

For each gap, identify the missing or weaker method, its causal result, the
stronger comparison behavior, and the evidence boundary. Say when a gap is only
observed once.

### <gap>

- Trigger or task condition:
- Missing or weaker method:
- Causal result:
- Stronger comparison behavior:
- Evidence:
- Confidence across contributing runs:

## Actionable practices to adopt

Write these as imperative instructions that an agent running
`harness={{CHARACTERIZED_HARNESS}} model={{CHARACTERIZED_MODEL}}` can execute.
Each practice must say when to use it, what to do, what to record, and how to
verify completion.

### <practice>

1. Trigger:
2. Steps to perform:
3. Evidence to record:
4. Verification signal:
5. Expected quality gain and supporting run:

## Regression checks for future runs

List observable checks that show whether this pair adopted the guidance and
whether later evidence strengthens, narrows, or refutes the characterization.
