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


## The pi harness (DeepSeek)

`pi` (`@earendil-works/pi-coding-agent`, pinned in `vendor-pins.json`) is a
fresh-spawn harness admitted wherever the claude harness is admitted, in every
role. It runs only DeepSeek models, under two names: `pi/flash` (the default
for a bare `pi`) and `pi/pro`. Each resolves at launch to the newest model of
its family that DeepSeek lists, falling back to the day cache and then to a
pinned id; the id chosen is recorded in `spawn.json` and a resume reuses it,
never re-resolving. No other model runs under pi and flash and pro run under
no other harness.
`pi/opus` and any other non-DeepSeek pair are refused.

pi runs under the pinned Bun through `bin/piy`; nothing launches Node. Its
key comes from the DeepSeek provider account (see `docs/CONFIG.md`
"`accounts.json`") and reaches pi only as `DEEPSEEK_API_KEY` in the pane's
environment, never in argv, `spawn.json` or a logged command line. Each agent
gets its own pi folder under its ledger: `pi-agent/` (pi's settings,
extensions and `models.json`) and `pi-sessions/` (its transcript). A restart
relaunches it with `--session <recorded id> --session-dir <ledger>/pi-sessions`,
so its history is kept.

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

## Find the reader first

Whoever writes a plan for another agent (a queue body, a todo bundle, a task
split, a fork's brief) first finds which model and effort will read it, shapes
the plan for that reader, and records who it was written for. Finding the
reader reads the route; it never chooses or changes one.

1. **How to find the reader**, in this order:
   - The row's own order: its `--model-hint` and `--effort`, shown by
     `throne render-queue`. The Lord gave those for that objective.
   - Else the live route for the role that will read the plan:
     `throne check-config` prints Alpha, Shadow and ShadowSlice99, each with
     its model and effort. A campaign role pin or allowlist, where one exists,
     narrows it (see "Campaign model allowlist operator override" below).
   - Else, when a pool holds several models or nothing can be read, the
     weakest model and lowest effort the reader could be. This is the old
     "write for the weakest configured reader" rule, kept as the fallback.

   Different plans have different readers: a queue body and a fork's brief are
   read by the Alpha or the forked Stager; ordinary todo files by the Shadow
   route; the 99 gate files by ShadowSlice99.

2. **Read that model's guidance** when the machine has any: the per-model files
   /gap-analysis-model writes, at the place its "Guidance output configuration"
   names. No file for the model means go by item 3 alone.

3. **What changes with the reader.** Effort counts as much as the model: the
   same model at low effort is a weaker reader than at high effort.
   - A weaker or lower-effort reader: smaller slices, each independently
     executable; every fork carries a default; every sweep carries its literal
     command and a stopping condition; files named by path; traps stated as
     traps; the reuse list exact; acceptance given as commands to run.
   - A stronger, higher-effort reader: state the outcome, the constraints, the
     traps and the acceptance, and leave the steps to it; fewer and larger
     slices; no line-by-line prescription, because a strong reader follows a
     wrong prescription faithfully and a plan that dictates every step hides
     the goal.
   - Always, for every reader: the Lord's rulings quoted, verified nouns, the
     reuse survey, the no-ask rule. These never thin out for a strong reader.
   - A reader from another model family: read that family's guidance first,
     since its failure modes differ.

4. **Record it** in one line:
   `Written for: <harness>/<model> at effort <n> (<how it was found>)`.
   It goes under `RULINGS:` in a queue body or a fork's brief, and in
   `00_overview.md` in a bundle (`verify.md` for a sliceless one).

5. **When the reader changes** after the plan was written (the Lord re-routes
   the campaign with /switch-campaign-model, or a row launches on another model
   than it was written for): the Alpha compares the recorded line with its own
   model at launch. When it is the weaker of the two, it treats the body as
   under-specified, does its own recon before planning, and records that it
   did. Nobody re-files the row.

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

When the Alpha's queue row carries a `--model-hint`, create-agent appends
that pair to the role-pool pairs it writes at the Alpha's registration, so an
opus or fable campaign's Shadows can use the model the Lord ordered. Filing
such a row also records the Lord's authorization in both Regent bypass
registries with recipient `*` for the objective code (`agent_docs/commands.md`,
add-to-queue). The hand edit below is now the fallback, for rows filed before
2026-09-23 or a pair the hint does not name.

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

There is deliberately no separate override command or backfill beyond the model hint. A
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
