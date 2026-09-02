---
name: gap-analysis-model
description: 'This throne-locally discovered, throne-runtime-only skill is for requests to "compare two models on the same task", run a "model A/B gap analysis", measure the "capability gap between fable and gpt-5.6-sol", or invoke "/gap-analysis-model". Only a registered Alpha in the authoritative live throne may invoke it; a Shadow must not invoke it. It runs one pinned nested `/write-and-execute-todos` campaign per compared model/harness pair and distills actionable per-model capability guidance from the stronger model.'
version: 0.5.0
user-invocable: true
---

# Gap analysis model

Run a controlled two-model comparison inside the throne. Each compared pair owns
an entire nested campaign: a second-tier Alpha on that exact pair plans and
executes the byte-equivalent task through its own `/write-and-execute-todos`
bundle, with every descendant pinned to the same harness, model, and shared
effort. The run's durable product is per-model capability guidance distilled by
the strongest, non-participant pair.

**Throne-locally discovered, throne-only at runtime.** Discovered natively from
a throne cwd, like the todo skills (`throne/.claude/skills/`), not through the
canonical global Claude/Codex tree. Invoke this skill only as a registered Alpha
in the authoritative live throne. It depends on the live throne registry, real
Shadow agents, throne-owned worktrees, and `src/tools.ts`. A Shadow must not
invoke it because the outer comparison campaign belongs to a registered
first-tier Alpha. Inside the run, the outer bundle's launcher Shadows DO spawn
second-tier Alphas: that is the explicitly sanctioned Shadow-to-Alpha case,
covered by the Normal collaboration law's model-comparison provenance
exception. Throne-local discovery does not relax the registered-Alpha
invocation guard; the runtime restriction lives in this skill's own contract,
not in its placement.

## Input contract

Collect these values before spawning anything:

- `TASK`: the complete task text. Give both nested campaigns the
  byte-equivalent task, acceptance criteria, source inputs, and allowed
  mutations.
- Pair A: canonical `HARNESS_A` and `MODEL_A`.
- Pair B: canonical `HARNESS_B` and `MODEL_B`.
- Optional `RUN_LABEL`. Normalize it to lowercase letters, digits, and hyphens;
  otherwise use a UTC timestamp.

**Compared-pair eligibility.** Each compared pair heads its own nested campaign
as a second-tier Alpha, so each pair must be admissible as an Alpha under the
live active plan. Read `<live-throne>/bin/throne-cli
list-harnesses-and-models --json` and require both pairs to appear in
`active_plan.rolePools.Alpha` (under `UnifiedRouting` that pool is
`claude/fable`, `claude/opus`, and `codex/gpt-5.6-sol`). Role pools are walls,
not steers: no bypass flag admits a pair the pool excludes, so reject an
out-of-pool pair with that exact reason instead of substituting a different
model. If a future in-pool pair's `planning` score falls below the Alpha floor
of 4, that pair additionally needs the loud one-spawn
`--bypass-alpha-guardrail` on its second-tier Alpha spawn; the current Alpha
pool has no such pair.

**Invoking-Alpha eligibility.** The invoking first-tier Alpha orchestrates and
distills but is not a comparison participant. Its own pair must rank at or
above both compared pairs in the live `MODEL_POLICY.md` ladder (lower rank
number means stronger), so the distillation runs on the strongest pair in the
experiment. Read the live registry at
`<live-throne>/agent_docs/MODEL_POLICY.md` before a run so a later registry
update wins over this snapshot. Reject an unknown model or a model paired with
the wrong harness instead of guessing its strength.

Choose one portable `COMPARE_EFFORT` score supported by both models and use it
unchanged for every second-tier spawn in both subtrees. Default to score 4. A/B
results are not comparable when effort changes with the model. Use bounded score
3 (`high`) for the context-heavy distillation slice; never use score
6/ultracode for that phase.

## Resolve the live throne and ledger

Use the same authority boundary as throne Shadow orchestration: the live throne
root is the main checkout owning `src/tools.ts`; a linked worktree's `.git` file
does not establish that authority. The live registry is independently rooted at
`$THRONE_DATA`, defaulting to `~/.throne/data`.

```bash
ALPHA="<your canonical herdr name; you are the invoking Alpha>"
THRONE_DATA="${THRONE_DATA_HOME:-$HOME/.throne}/data"

throne_from() { d="$1"; while [ "$d" != / ]; do \
  top="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)"; \
  [ -f "$d/src/tools.ts" ] && [ -n "$top" ] && [ -d "$top/.git" ] && { printf '%s' "$d"; return; }; \
  d="$(dirname "$d")"; done; }

registered_campaign_repo_from() { agent_dir="$THRONE_DATA/$ALPHA"; \
  [ -f "$agent_dir/identity.md" ] || return 0; \
  node -e 'try{const b=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));const p=require("node:path");if(b.name===process.argv[2]&&typeof b.repo==="string"&&p.isAbsolute(b.repo))process.stdout.write(b.repo)}catch{}' "$agent_dir/tree-base.json" "$ALPHA" 2>/dev/null; }

THRONE="$(throne_from "$PWD")"
CAMPAIGN_REPO=""
[ -n "$THRONE" ] && CAMPAIGN_REPO="$(registered_campaign_repo_from "$THRONE")"

if [ -z "$THRONE" ]; then
  # Select the Regent from herdr's roster with the throne's OWN name contract:
  # `sameAgentName` (case-insensitive both sides) + `resolveAgent`'s exactly-one
  # rule. `herdr agent get <name>` matches EXACTLY, so one hardcoded spelling
  # (`Regent` vs the live lowercase `regent`) misses the live Regent entirely.
  REGENT_CWD="$(herdr agent list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const want=process.argv[1].toLowerCase();const m=(JSON.parse(s).result?.agents??[]).filter(a=>typeof a?.name==="string"&&a.name.toLowerCase()===want);if(m.length===1&&typeof m[0].cwd==="string")process.stdout.write(m[0].cwd)}catch{}})' Regent 2>/dev/null)"
  if [ -n "$REGENT_CWD" ]; then
    CAND="$(throne_from "$REGENT_CWD")"
    [ -n "$CAND" ] && CAMPAIGN_REPO="$(registered_campaign_repo_from "$CAND")"
    [ -n "$CAMPAIGN_REPO" ] && THRONE="$CAND"
  fi
fi

[ -n "$THRONE" ] || { echo "gap-analysis-model: no authoritative live throne" >&2; exit 1; }
```

Always call `"$THRONE/bin/throne-cli" ...`; never call a worktree's relative
copy. Resolve the campaign repository once from the Alpha's registration. Do not
hand-guess it. Omit `--repo` for throne self-work and pass the recorded repo only
for a cross-repo campaign:

```bash
THRONE_REPO="$(realpath -e "$(git -C "$THRONE" rev-parse --show-toplevel)")"
repo_flag=()
if [ -n "$CAMPAIGN_REPO" ]; then
  CAMPAIGN_REPO_ROOT="$(realpath -e "$(git -C "$CAMPAIGN_REPO" rev-parse --show-toplevel)")"
  [ "$CAMPAIGN_REPO_ROOT" = "$THRONE_REPO" ] || repo_flag=(--repo "$CAMPAIGN_REPO")
fi

RAW_LABEL="${RUN_LABEL:-$(date -u +%Y%m%d-%H%M%S)}"
RUN_LABEL="$(printf '%s' "$RAW_LABEL" | tr '[:upper:]_' '[:lower:]-' | \
  sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
[ -n "$RUN_LABEL" ] || { echo "gap-analysis-model: empty run label" >&2; exit 1; }

RUN_DIR="$THRONE_DATA/$ALPHA/gaprun-$RUN_LABEL"
[ ! -e "$RUN_DIR" ] || { echo "gap-analysis-model: run ledger already exists: $RUN_DIR" >&2; exit 1; }
mkdir -p "$RUN_DIR"

COMPARE_EFFORT="${COMPARE_EFFORT:-4}"
DISTILL_EFFORT=3

# Objective-coded, collision-safe canonical names for the two nested campaigns.
# Objective codes are lowercase alphanumeric; the run label keeps names unique
# because the ledger existence check above refuses a reused label.
RUN_CODE="$(printf '%s' "$RUN_LABEL" | tr -cd 'a-z0-9')"
CODE_A="gap${RUN_CODE}a"; ALPHA_A="alpha-${CODE_A}-campaign"
CODE_B="gap${RUN_CODE}b"; ALPHA_B="alpha-${CODE_B}-campaign"

# Separate ledger ROOTS, not two children of one run directory. Each side's
# evidence lives under its own campaign Alpha's registered agent directory, so
# this skill creates no A/B adjacency a campaign could list its sibling out of.
A_DIR="$THRONE_DATA/$ALPHA_A/gaprun-$RUN_LABEL"
B_DIR="$THRONE_DATA/$ALPHA_B/gaprun-$RUN_LABEL"
mkdir -p "$A_DIR" "$B_DIR"
A_WORKLOG_PATH="$A_DIR/WORKLOG.md"; A_RESULT_PATH="$A_DIR/RESULT.md"
B_WORKLOG_PATH="$B_DIR/WORKLOG.md"; B_RESULT_PATH="$B_DIR/RESULT.md"
```

The ledger is outside every worker worktree. Every assignment must use these
absolute paths. Relative `data/...` paths silently point at a worktree that does
not contain the live ledger.

## Guidance output configuration (the single named configuration point)

This is the ONLY place the durable publication destination is defined. Every
other section and template consumes `guidance_dir_for`; none hard-codes a
guidance path.

```bash
# Repo-relative home of the global cross-harness agent-docs tree that both
# harness families bootstrap from. Published (post-merge) at
# "$HOME/.claude/../agent_docs", family subdirectories "Claude" and "GPT".
GUIDANCE_SUBDIR="claude/agent_docs"

# Model FAMILY, not harness, selects the directory: guidance describes how a
# model behaves, and the same family is reachable through more than one
# harness. Refuse an unmapped family loudly instead of guessing a destination.
guidance_family_for() {
  case "$2" in
    gpt-*|o[0-9]*|codex-*) printf 'GPT' ;;
    fable*|opus*|sonnet*|haiku*|claude-*) printf 'Claude' ;;
    *) echo "gap-analysis-model: no guidance family mapped for harness=$1 model=$2" >&2; return 1 ;;
  esac
}

# $1 distiller worktree root, $2 harness, $3 model.
guidance_dir_for() {
  fam="$(guidance_family_for "$2" "$3")" || return 1
  printf '%s/%s/%s' "$1" "$GUIDANCE_SUBDIR" "$fam"
}
```

The base is the GLOBAL tree because the product characterizes models, not this
repository: a Claude session and a Codex session must each reach their own
family's guidance through the bootstrap ritual they already run. The two
compared pairs may map to the same family directory; they always keep distinct
`<harness>-<model>.md` filenames.

The path is resolved against the DISTILLER's worktree root, not `$HOME`, and
reaches the published location through `merge-git-tree`. Writing straight into
the live checkout would break the same worktree discipline every other worker
in the run obeys. Consequence: the distillation slice's worktree must be on the
repository that owns the global `agent_docs` tree — spawn it with no `--repo`
override even when the compared TASK targets another repository, and refuse to
distil into a tree that has no `$GUIDANCE_SUBDIR` directory.

## Template rendering contract

Render templates mechanically into each worker's absolute
`$THRONE_DATA/<worker>/ASSIGNMENT.md`. Do not tell a worker to read a template
later. Large multi-section briefs stay file-based: one quoted `send-agent`
argument preserves embedded newlines, while multiple positional arguments are
space-joined, but a pointer to an assignment file is the proven channel for a
large brief.

Use these common placeholders consistently:

- `{{ALPHA}}`, `{{RUN_LABEL}}`, `{{TASK}}`, and `{{THRONE}}`.
- `{{PAIR_ID}}`, `{{HARNESS}}`, `{{MODEL}}`, and `{{EFFORT}}` for the worker's
  own identity.
- `{{CAMPAIGN_ALPHA}}` and `{{OBJECTIVE_CODE}}` for a second-tier Alpha's own
  canonical name and campaign code.
- `{{A_HARNESS}}`, `{{A_MODEL}}`, `{{B_HARNESS}}`, and `{{B_MODEL}}` whenever a
  worker sees both pairs.
- `{{A_WORKLOG_PATH}}`, `{{A_RESULT_PATH}}`, `{{B_WORKLOG_PATH}}`, and
  `{{B_RESULT_PATH}}` for absolute evidence paths.
- `{{SHADOW_ADDR}}` for a first-tier worker's own canonical handle, and
  `{{A_OUTPUT_DIR}}` / `{{B_OUTPUT_DIR}}` for the two resolved family guidance
  directories. Both are Phase-2-only: a Phase 1 assignment carries neither,
  because either would name the sibling.

The four templates have these exact interfaces:

- `templates/campaign-assignment.md`: fill the common fields, the second-tier
  Alpha's identity (`{{CAMPAIGN_ALPHA}}`, `{{OBJECTIVE_CODE}}`, its pinned
  pair and `{{EFFORT}}`), the same complete task, `{{WORKLOG_PATH}}`, and
  `{{RESULT_PATH}}`. Append the fully rendered
  `templates/worklog-template.md` body to this assignment so the campaign
  receives the log schema inline.
- `templates/worklog-template.md`: fill run, pair, harness, model, task, and the
  absolute output paths. It is the skeleton the second-tier Alpha writes to
  `WORKLOG.md` and extends after every meaningful campaign step.
- `templates/distillation-assignment.md`: fill the distiller's identity and the
  orchestrator's pair, both compared pair identities, all four worklog/result
  paths, `{{A_OUTPUT_DIR}}`, `{{B_OUTPUT_DIR}}`, the run label, and the task.
  Append the rendered
  `templates/durable-doc-template.md` body.
- `templates/durable-doc-template.md`: fill
  `{{CHARACTERIZED_HARNESS}}`, `{{CHARACTERIZED_MODEL}}`, `{{RUN_LABEL}}`, and
  `{{TASK_CLASS}}` once per characterized pair. Its visible metadata must contain
  the exact tags `harness=<value> model=<value>` and its prose must be ASCII.

Use the harness's file-writing tools to preserve arbitrary multiline task text;
do not substitute the task through an unsafe shell `sed` command. Before sending
the pointer, verify that the assignment is nonempty and contains no unresolved
uppercase placeholders:

```bash
assignment_path="$THRONE_DATA/$addr/ASSIGNMENT.md"
test -s "$assignment_path"
if rg -n '\{\{[A-Z][A-Z0-9_]*\}\}' "$assignment_path"; then
  echo "gap-analysis-model: unresolved assignment placeholder" >&2
  exit 1
fi
"$THRONE/bin/throne-cli" send-agent "$addr" \
  "Read and execute your assignment at $assignment_path. Work only in your own cwd and the absolute output paths named there. Report DONE to $ALPHA via send-agent. Genuine blockers go to Regent."
```

## Evidence standard

Make method narration part of the experiment, not an afterthought. Each nested
campaign must keep the worklog discipline: every second-tier Shadow records its
method in its slice execution log, and the second-tier Alpha aggregates those
records into its side's `WORKLOG.md` at every meaningful campaign step,
recording:

1. What was inspected and why.
2. The tool, command, query, or source used.
3. The observation and the conclusion drawn from it.
4. Any plausible lead refuted and the evidence that refuted it.
5. The next step, correction, assumption, or unresolved limit.

For technical analysis, require depth practices when applicable: trace flattened
or derived data back to authoritative sources; retrieve the actual primary
datasheet and relevant vendor reference-design BOMs; calculate suitability with
units, margins, and derating; inspect rasterized design sheets for human
annotations; and refute weak leads instead of reporting them. Treat rule-checker
output as leads and compress raw checker counts to a one-line note. The comparison
must expose causal method gaps such as "the model skipped the datasheet, so it
missed the voltage-rating failure", not merely list different conclusions.

Write all skill-owned Markdown artifacts in ASCII. Preserve raw external strings
only when evidence requires them, and explain them with ASCII text.

## Phase 1: two pinned nested campaigns

The invoking first-tier Alpha runs one outer three-slice
`/write-and-execute-todos` bundle:

- Slice 01: launch campaign A — a first-tier launcher Shadow spawns second-tier
  Alpha `$ALPHA_A` pinned to pair A and delivers its campaign assignment.
- Slice 02: launch campaign B — a second launcher Shadow does the same for
  `$ALPHA_B` and pair B.
- Slice 03: collect, distill, and validate — barriers on both campaigns, audits
  the pins, and produces the durable guidance (Phase 2 below).

The launcher slices are ordinary campaign Shadows of the outer bundle, spawned
and steered normally by `/execute-todos`; only the comparison subtrees are
pinned. A launcher slice completes when its campaign is LAUNCHED and verified,
not when the campaign finishes — the outer slices run serially, and both inner
campaigns must start from the same target-repo commit and run concurrently.
Slice 01 must therefore create BOTH campaign worktrees before either campaign
mutates anything; slice 02 then registers and briefs `$ALPHA_B` on the tree
slice 01 already created.

Each launcher slice is the sanctioned Shadow-to-Alpha spawn. It runs, for its
side's pair:

```bash
# Slice 01 only: create both Alpha worktrees back to back so A and B share the
# same base commit. Alpha-named trees base on the target repo's current branch.
tree_a="$("$THRONE/bin/throne-cli" spawn-git-tree "$ALPHA_A" "${repo_flag[@]}")"
tree_b="$("$THRONE/bin/throne-cli" spawn-git-tree "$ALPHA_B" "${repo_flag[@]}")"

# Per launcher slice: render the campaign assignment BEFORE the spawn so the
# booting Alpha finds it, then register the pinned second-tier Alpha.
addr="$ALPHA_A"   # slice 02 uses ALPHA_B, HARNESS_B, MODEL_B, CODE_B, tree_b
mkdir -p "$THRONE_DATA/$addr"
# render templates/campaign-assignment.md + worklog-template.md to
# "$THRONE_DATA/$addr/ASSIGNMENT.md" (see the template rendering contract)

guardrail_flag=()
# Required only when the pinned pair's live planning score is below the Alpha
# floor of 4; no current Alpha-pool pair needs it:
# guardrail_flag=(--bypass-alpha-guardrail)

"$THRONE/bin/throne-cli" create-agent \
  --harness "$HARNESS_A" --model "$MODEL_A" --effort "$COMPARE_EFFORT" \
  --name "$addr" --supervisor "$ALPHA" --escalation Regent \
  --role Alpha --objective-code "$CODE_A" \
  --bypass-model --bypass-effort \
  "${guardrail_flag[@]}" --cwd "$tree_a"
```

`--bypass-model --bypass-effort` is mandatory on EVERY spawn in
a comparison subtree, at both tiers. The two flags each disable exactly one
steer: without `--bypass-model` the engine steers the pair (the Alpha allowed
set, the reserved `claude/fable` execution exclusion, and the 99 gate's
capability-selected validator), usage steering remains mandatory and may route
the pair away, and without `--bypass-effort` it refuses the explicit shared
`COMPARE_EFFORT`. A silently rerouted descendant invalidates the experiment.
The bypasses override steers only: role pools, the Alpha planning floor, the
gate validation floor, and the native Claude quota gate all still hold. If the
native quota gate refuses a pinned `claude/fable` or `claude/opus` spawn, wait
and retry with the same pinned pair; never substitute a model.

Set the second-tier Alpha's supervisor to the invoking first-tier Alpha, not to
the launcher Shadow: the launcher is verified, merged, and reaped once the
launch lands, while the campaign's DONE report must reach the durable
orchestrator that collects the run.

After the spawn, the launcher verifies durable spawn evidence and refuses on
any mismatch:

```bash
node -e 'const s=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
const [h,m,e]=process.argv.slice(2);
if(s.harness!==h||s.model!==m||String(s.effort)!==e){console.error("pin mismatch",s);process.exit(1)}' \
  "$THRONE_DATA/$addr/spawn.json" "$HARNESS_A" "$MODEL_A" "$COMPARE_EFFORT"
```

The launcher then sends the assignment pointer (template rendering contract
above), confirms via `agent-logs` that the campaign Alpha acknowledged its
assignment, and reports DONE to the invoking Alpha with the spawn evidence.

### The nested campaign contract (rendered into each campaign assignment)

Each second-tier Alpha:

- Receives the byte-equivalent `TASK` and runs its own N-slice
  `/write-and-execute-todos` bundle in its own worktree: it authors the bundle,
  spawns its own second-tier Shadows via `derive-shadow-name-from-alpha`, and
  owns their whole lifecycle, exactly like any campaign Alpha.
- Pins every descendant: EVERY spawn it makes — every ordinary slice worker and
  its `99` validate gate — requests exactly its own harness and model with
  `--effort $COMPARE_EFFORT --bypass-model --bypass-effort`.
  This fixed provenance is the sanctioned model-comparison exception to
  ordinary outcome-based collaboration; record it in the bundle so every slice
  knows rerouting is forbidden. Every eligible compared pair clears the gate's
  `validation>=4` floor, so the pinned same-pair `99` gate is admissible by
  construction.
- Verifies `$THRONE_DATA/<shadow>/spawn.json` after every spawn and treats any
  harness/model/effort mismatch as a blocker: reap the mis-spawned worker and
  respawn pinned; never proceed on a rerouted descendant.
- Aggregates its campaign's method evidence into its side's absolute
  `WORKLOG.md` and writes its side's `RESULT.md` in its own ledger root. Pair A
  owns only `$A_DIR/`; pair B owns only `$B_DIR/`. Neither is told the other
  path exists.
- Honors the task's mutation boundary. A read-only analysis permits no source
  edits; deliverables go to the ledger. For a mutating task, keep the work in
  the campaign's own worktree lineage, and record the base commit plus the
  complete durable patch or diff in `RESULT.md` — a commit SHA alone is
  insufficient because later phases consume ledger evidence after teardown.
- Reports DONE to the invoking first-tier Alpha when its bundle completes and
  both files are nonempty.

### Phase 1 clean-room isolation (enforced, not promised)

Both campaigns execute the same task blind to each other. The separation is the
experiment, so it is enforced by construction, by a pre-send gate, and by a
post-run audit over durable ledger and bundle evidence plus a bounded captured
recent-output window — never by the assignment's prose alone.

**By construction.** Separate worktrees (`spawn-git-tree` per campaign Alpha),
separate branches (each Alpha's own name), separate ledger roots (`$A_DIR` and
`$B_DIR`, which are not siblings), separate objective codes (`$CODE_A`,
`$CODE_B`) and therefore disjoint descendant handles. No shared scratch file,
no shared branch, and no shared parent directory this skill creates.

**Pre-send gate.** A standalone assignment must name no sibling identity or
path. Run this over every rendered Phase-1 assignment BEFORE its `send-agent`,
and refuse the launch on any hit:

```bash
# $side_tokens: this side's own tokens; $sibling_tokens: the other side's.
assert_no_sibling_leak() {
  assignment="$1"; shift
  for tok in "$@"; do
    [ -n "$tok" ] || continue
    if grep -qF -- "$tok" "$assignment"; then
      echo "gap-analysis-model: sibling token '$tok' leaked into $assignment" >&2
      return 1
    fi
  done
}

# Slice 01 renders A's assignment and checks it against B's tokens; slice 02
# renders B's and checks it against A's. Effort is deliberately NOT a sibling
# token: it is shared by design.
assert_no_sibling_leak "$THRONE_DATA/$ALPHA_A/ASSIGNMENT.md" \
  "$ALPHA_B" "$CODE_B" "$HARNESS_B" "$MODEL_B" "$B_DIR" "$tree_b" || exit 1
```

The rendered assignment therefore states only that the work is independent and
that contacting or inspecting any other agent's ledger, logs, panes, branches,
worktrees, output history, or agent records is forbidden. It never says who the
sibling is, which pair it runs, or where its evidence lives.

**Residual, stated honestly.** `$THRONE_DATA/` is the throne-wide agent ledger
and stays listable by any agent; no filesystem permission boundary exists
between registered agents. Blindness is therefore enforced as a forbidden-read
law plus the audit below, not claimed as impossible access. Do not write that
the sibling is unreachable.

**Post-run audit.** After both campaigns report DONE and before ANY exposure,
merge, collection, or distillation, audit each side's durable ledger root and
todo bundle for sibling contamination. Also capture and audit a bounded
recent-output window of up to 2,000 lines from each campaign Alpha. The window
is neither complete nor durable evidence: earlier output may have scrolled out.

```bash
audit_blindness() { # $1: side ledger root  $2: campaign alpha  $3..: sibling tokens
  root="$1"; alpha="$2"; shift 2
  "$THRONE/bin/throne-cli" agent-logs "$alpha" --lines 2000 > "$RUN_DIR/$alpha.log" || return 1
  for tok in "$@"; do
    [ -n "$tok" ] || continue
    if grep -rqF -- "$tok" "$root" "$THRONE_DATA/$alpha" "$RUN_DIR/$alpha.log"; then
      echo "gap-analysis-model: BLINDNESS BREACH - '$tok' observed in $alpha evidence" >&2
      return 1
    fi
  done
}

audit_blindness "$A_DIR" "$ALPHA_A" "$ALPHA_B" "$CODE_B" "$MODEL_B" "$B_DIR" || exit 1
audit_blindness "$B_DIR" "$ALPHA_B" "$ALPHA_A" "$CODE_A" "$MODEL_A" "$A_DIR" || exit 1
```

A breach invalidates the run's comparability. Report it; never distill around
it and never launder it into guidance.

### The Phase 1 exit barrier

Slice 03 barriers on explicit DONE from both campaign Alphas. Idle status alone
is not completion. Watch each with:

```bash
"$THRONE/bin/throne-cli" agent-logs "$addr" --lines 200
```

Nothing is exposed, merged, collected, or distilled until ALL of the following
pass, in this order:

1. Both campaign Alphas sent an explicit DONE report.
2. Artifact integrity: all four `WORKLOG.md`/`RESULT.md` files exist, are
   nonempty, and are ASCII.
3. Pin audit: every registered agent whose name carries `$CODE_A` or `$CODE_B`
   has `spawn.json` matching its own subtree's exact pinned harness, model, and
   `COMPARE_EFFORT`.
4. Blindness audit: both `audit_blindness` calls above pass.

A failure at any step stops the run there. A pin mismatch or a blindness breach
anywhere invalidates the run; report it instead of distilling around it.

## Phase 2: stronger-model distillation

Distillation is the outer bundle's slice 03, running directly after both
campaigns finish. The invoking Alpha spawns it as an ordinary first-tier
campaign Shadow of the outer bundle, pinned to the ORCHESTRATOR's own pair —
the strongest pair in the experiment and not a comparison participant — with
the same three bypass flags and the bounded `DISTILL_EFFORT=3` (the portable
`high` token, deliberately below max and ultracode; a previous context-heavy
synthesis stalled twice at higher effort). Resolve its two output directories
from the single configuration point above, against the distiller's own tree:

```bash
distill_tree="$("$THRONE/bin/throne-cli" spawn-git-tree "$distiller")"  # no --repo: the
# guidance tree lives in the throne's own repo, never the campaign target repo
A_OUTPUT_DIR="$(guidance_dir_for "$distill_tree" "$HARNESS_A" "$MODEL_A")" || exit 1
B_OUTPUT_DIR="$(guidance_dir_for "$distill_tree" "$HARNESS_B" "$MODEL_B")" || exit 1
[ -d "$distill_tree/$GUIDANCE_SUBDIR" ] || { echo "gap-analysis-model: distiller tree has no $GUIDANCE_SUBDIR" >&2; exit 1; }
mkdir -p "$A_OUTPUT_DIR" "$B_OUTPUT_DIR"
```

Render `templates/distillation-assignment.md` plus
`templates/durable-doc-template.md`. Pass both worklogs, both results, both
pair identities, the task, run label, and both absolute output dirs. Require the
distiller to read all four evidence files before writing; it may also read the
two campaign bundles under `$THRONE_DATA/$ALPHA_A/` and
`$THRONE_DATA/$ALPHA_B/` read-only to resolve a disputed method claim.

The distiller must create or refine one actionable document per compared pair,
each named `<harness>-<model>.md` under that pair's own family directory. Tag
every characterization with the exact visible metadata
`harness=<harness> model=<model>`. Accumulate evidence across runs instead of
replacing prior supported guidance. Cite the run label and source ledger paths,
separate observed behavior from inference, and turn each stable gap into a
concrete instruction the characterized model can follow on the same task class.
The strategic product is guidance that lets an abundant weaker model adopt the
scarce stronger model's useful method, not a winner scoreboard.

### Claim-accuracy gate

Every capability assertion in each resulting durable document, including
claims preserved from an earlier run, must use the `capability-claim` block
from `templates/durable-doc-template.md`. Migrate any older unstructured claim
before publication; preserving its prose does not exempt it. A block names
one concrete statement, exactly one of the run's four WORKLOG/RESULT files, and
an exact single-line excerpt present in that file. Use multiple blocks when a
cross-model conclusion depends on more than one artifact. An inference still
needs a grounded observed premise; label the statement as inference inside the
block instead of citing reputation, recollection, or polished guesswork.

After both documents are written, run the skill-owned validator against each:

```bash
validator="$THRONE/.claude/skills/gap-analysis-model/validate-claim-evidence.mjs"
for guidance in \
  "$A_OUTPUT_DIR/$HARNESS_A-$MODEL_A.md" \
  "$B_OUTPUT_DIR/$HARNESS_B-$MODEL_B.md"
do
  node "$validator" "$guidance" \
    "$A_WORKLOG_PATH" "$A_RESULT_PATH" "$B_WORKLOG_PATH" "$B_RESULT_PATH" || exit 1
done
```

The validator checks claim accuracy only: the cited file must be one of the
four admitted campaign artifacts and the cited excerpt must occur there
verbatim. It does not score style, tone, completeness, actionability, or any
other subjective quality. A failed claim blocks publication until it is removed
or corrected from the primary campaign evidence; never soften the validator to
admit a desirable-sounding claim.

Require checkpoint-sized Write/Edit operations and a focused commit in the
distiller worktree. Do not ask for one giant streamed synthesis. Incremental
file writes and ASCII output are hard reliability constraints; Unicode glyphs
were dropped by a previous renderer.

Barrier on explicit DONE. Verify the durable docs exist, are committed, contain
the exact harness/model tags, characterize both pairs, and contain actionable
instructions. Re-run the claim-accuracy gate after the worker's commit so the
committed documents, rather than an earlier draft, are the artifacts validated.

## Merge and teardown contract

The invoking Alpha owns every first-tier lifecycle transition; each second-tier
Alpha owns its own Shadows' lifecycle inside its campaign. For each first-tier
worker and each campaign Alpha, in order:

1. Watch `agent-logs` until an explicit DONE report arrives.
2. Verify the phase's required outputs and any required commit.
3. Run `merge-git-tree` before teardown.
4. Reap only after verification and merge succeed.

```bash
"$THRONE/bin/throne-cli" merge-git-tree "$addr" "<merge message>"
"$THRONE/bin/throne-cli" reap-agent "$addr" --force --reason completed
```

`merge-git-tree` lands each tree into the base branch recorded in its own
`tree-base.json` at spawn time. A second-tier Alpha's tree bases on the target
repo's current branch, so it merges back exactly where it branched from; a
second-tier Shadow lands in its campaign Alpha's branch through that Alpha's
own `/execute-todos` flow.

Tearing down a campaign Alpha archives its whole `~/.throne/data/<name>/`, and each
side's ledger root lives there. So before reaping either campaign Alpha, slice
03 must have finished distilling AND copied the four evidence files into the
orchestrator's run directory as the durable run record:

```bash
mkdir -p "$RUN_DIR/$CODE_A" "$RUN_DIR/$CODE_B"
cp "$A_WORKLOG_PATH" "$A_RESULT_PATH" "$RUN_DIR/$CODE_A/"
cp "$B_WORKLOG_PATH" "$B_RESULT_PATH" "$RUN_DIR/$CODE_B/"
```

This is the first sanctioned point at which the two sides share a directory:
Phase 1 is over, both barriers passed, and the copy is the orchestrator's
record, not an input to either campaign. For mutating
tasks, the results' recorded diffs remain the comparison evidence if landing
the two campaign branches requires conflict resolution.

The force flag is intentional only after verified completion. Workers that send
DONE remain live-idle and do not write `REPORT.md`, so plain reap refuses them.
A campaign Alpha with live children refuses plain reap; its own campaign must
have reaped its Shadows before the invoking Alpha tears it down. Never
force-reap a worker that is still working or whose outputs are unverified. If a
barrier fails, do not advance the run or silently substitute a different model;
resolve or retry with the same pinned pair.

## Run deliverables

A complete run leaves:

```text
# During the run: separate, non-adjacent ledger roots (Phase 1 blindness).
$THRONE_DATA/<campaign-alpha-a>/gaprun-<label>/{WORKLOG.md,RESULT.md}
$THRONE_DATA/<campaign-alpha-b>/gaprun-<label>/{WORKLOG.md,RESULT.md}

# After the Phase 1 barrier: the orchestrator's durable run record.
$THRONE_DATA/<alpha>/gaprun-<label>/
  <code-a>/{WORKLOG.md,RESULT.md}
  <code-b>/{WORKLOG.md,RESULT.md}
  <campaign-alpha>.log        # captured recent-output window, up to 2,000 lines

# The published product, landed by merge-git-tree.
~/.claude/../agent_docs/Claude/<harness>-<model>.md
~/.claude/../agent_docs/GPT/<harness>-<model>.md
```

The two campaign worklogs are equally required: they preserve each side's
recorded method so the distillation compares evidence, not recollection. The
durable, harness/model-tagged documents are the actionable product of the run.
