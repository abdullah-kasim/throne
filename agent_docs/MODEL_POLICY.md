# Model policy for throne todo workflows

Executable policy is authoritative. Inspect the current registry, active preset,
ordered role pools, mechanically spawnable pairs, and effort ranges with:

```text
<live-throne>/bin/throne-cli list-harnesses-and-models --json
```

The output is derived from the routing configuration and the canonical model
registry. Documentation must not copy transient pair availability or route values.

## Admission contract

`resolveSpawnAdmission` is the single authority for fresh admission. It
canonicalizes the requested pair, confirms that the registry can spawn it, and
enforces the active role's full-pair pool. It returns either that admitted pair
with its reason or a refusal; it never chooses a stronger pair, retries with a
different pair, or escalates automatically.

The active preset supplies the default pair pool for each role: Alpha,
ordinary Shadow, and terminal Shadow. A role pin or a non-empty campaign
`model-allowlist.json` may select that campaign's permitted pool instead. A
valid human queue `model_hint` is explicit harness/model provenance: the queued
Alpha records it in `spawn.json`, and only that Alpha's recorded descendants
inherit it. It never crosses campaign boundaries or authorizes a sibling
campaign. A `model_hint` must match `create-agent --model`; it can document and
mechanically validate that route, but can never replace it. An explicit
`--model` therefore launches verbatim after admission or is refused.

The Lord or Regent may make a scoped one-off exception through the existing
durable authorization records. An exception must be recorded before launch;
agents cannot infer or self-authorize one. A dated evidence-based
disqualification remains effective until its documented exit test passes.

If an explicit, pinned, hinted, or preset pair cannot be admitted, surface the
refusal to the Regent for a human route decision. Automatic escalation and
retry ladders are permanently forbidden. Preserve documented migration routes
until their deliberate retirement criteria have been met.

## Workflow responsibilities

`write-todos`, `create-agent`, `switch-agent-model`, and
`list-harnesses-and-models` use the same admission resolution semantics rather
than independently calculating eligibility. `write-todos` records a nullable
`model_hint` when the human queue request provides one; `create-agent` persists
the admitted route and reason; registered switching consults the same resolver.

Fresh spawns may use only an admitted mechanically spawnable pair. Exact
registered resumes retain their stored harness, model, and effort, subject to
their existing lifecycle and availability checks. Effort is a launch setting;
it neither ranks models nor alters admission.

## Campaign model allowlist operator override

A campaign Alpha owns its allowlist at:

```text
<throne data home>/<alpha-name>/model-allowlist.json
```

On the standard installation, the data home is `~/.throne/data`, so Alpha
`alpha-mal-model-allowlist` uses
`~/.throne/data/alpha-mal-model-allowlist/model-allowlist.json`.
The file has this exact JSON shape: a top-level `version` of `1` and a `pairs`
array whose entries contain only non-empty `harness` and `model` strings.

For a Regent-approved exception that permits `fable` for the Alpha, ordinary
Shadow, and terminal `ShadowSlice99` pools, edit the owning Alpha's file to:

```json
{
  "version": 1,
  "pairs": [
    {
      "harness": "claude",
      "model": "fable"
    }
  ]
}
```

All three roles resolve this same campaign-owned pair pool: an Alpha resolves
its own file and a Shadow (including `ShadowSlice99`) resolves its supervising
Alpha's file. Include every pair that the campaign must be able to launch;
once a valid non-empty file exists, it overrides the preset pool and no bypass
flag can admit an omitted pair.

There is deliberately no separate override command or automatic backfill. A
missing file, malformed JSON, any unexpected or malformed field, or an empty
`pairs` array degrades to **no campaign allowlist**; normal preset admission
continues rather than becoming deny-all. This is a compatibility fallback, not
evidence that the intended exception was recorded.

This ledger is not tamper-proof. The owner Alpha runs under the same OS user
and can edit its own file; Shadows consult the supervisor Alpha's file rather
than an independently protected record. Treat an edit as a Regent-authorized
operator action and preserve the authorization evidence outside the file.

## Migration and evidence

Existing preset pairs, role pins, allowlists, authorized exceptions, and
registered-resume routes remain live during their documented migration windows.
Inspect command output and durable spawn evidence instead of reproducing a
model table here. Historical score material may remain only as clearly labeled
historical evidence; it is not an admission rule.
