---
name: review-loop
description: 'This throne-locally discovered, throne-runtime-only skill runs a bounded review-and-fix loop: the Lord (or an inheriting invoker) names what needs to be reviewed and done, and which model reviews it, and the skill alternates reviewer rounds with fixer Alphas until one of three mandatory termination bounds fires. Invoked by /review-loop, or when the tasking says "review and fix this in a loop", "run a review-fix loop", "generalize RFL", or names a reviewer model and a target to iterate against. Only a registered Alpha in the authoritative live throne may invoke it; a Shadow must not invoke it. The loop Alpha never spawns — every reviewer and every fixer is requested from the Regent.'
version: 0.1.0
user-invocable: true
---

# Review loop

Generalizes the live `alpha-rfl-review-fix-loop` instance
(`~/.throne/data/alpha-rfl-review-fix-loop/todo-20260808T163538Z-review-fix-loop/00_overview.md`)
into a reusable throne skill. Every mechanism below is traced to that ledger
or to the Regent's live rulings in
`~/.throne/data/regent/brief-2026-08-09-review-loop-skill.md` — this skill
invents no second design.

**Throne-locally discovered, throne-only at runtime.** Discovered natively
from a throne cwd (`throne/.claude/skills/`), per the cross-harness carve-out
in the operator's global instructions, §"Cross-harness skills" — this directory is
project-scoped, outside `sync-global-agent-skills`'s managed topology, and
must not be "fixed" back into the canonical global tree. Invoke this skill
only as a registered Alpha in the authoritative live throne; a Shadow must
not invoke it, because the loop is itself a campaign-Alpha-level
orchestration role that requests spawns from the Regent.

## Entry guard — throne context only, resolved once

This skill runs ONLY inside the throne orchestrator. Reuse the canonical
resolver — do not paste a second copy of it. See
`execute-todos/SKILL.md` → "Entry guard — throne context only, resolved
once" for the exact shell function (`throne_from`, `registered_campaign_repo_from`,
`registered_alpha_from`, the `$THRONE`/`$THRONE_DATA`/`$CAMPAIGN_REPO`
fast-path-then-Regent-fallback resolution). Run it before touching anything
below; every later step uses its `$THRONE` value and always invokes
`"$THRONE/bin/throne-cli" ...` absolutely, never a worktree's relative copy (per
`77db50353`, an agent must never `cd` into the live root to reach the CLI).

## Input contract

Two required invocation params. Missing either refuses by name — never a
silent default, never a guess:

- `OBJECTIVE` — what needs reviewing and fixing, plus its `TARGET_REPO`
  (the absolute path of the repository the loop iterates against). Refusal:
  `"review-loop: missing OBJECTIVE (what to review and its TARGET_REPO)"`.
- `REVIEWER_MODEL` (with its harness) and `REVIEWER_EFFORT` — which model
  reviews, and at what effort. Refusal:
  `"review-loop: missing OBJECTIVE (what to review and its TARGET_REPO)"`.

Everything past this point is the skill's own job, not the invoker's —
these are exactly the parts that took RFL a live campaign and six Regent
corrections to get right.

## Pre-flight gate — run once before round `01a`, all three mandatory

None of these three may be skipped, weakened, or deferred to round 1. A
failure here refuses loudly before a single round spawns.

### 1. Reviewer role-pool admissibility

Read `"$THRONE/bin/throne-cli" list-harnesses-and-models --json` and check
whether `REVIEWER_MODEL` (with its harness) appears in at least one of
`active_plan.rolePools.{Alpha,Shadow,ShadowSlice99}`.

State the mechanical fact plainly: **role-pool admission is a hard gate
outside the steering engine** — an unadmitted pair blocks a normal
Alpha/Shadow spawn no matter what flags are passed. This is not a bug to
route around.

- **Admitted to some pool:** the reviewer request to the Regent may name a
  normal Alpha/Shadow spawn shape.
- **Admitted to no pool, but obtainable as an ad-hoc Agent:** the documented
  resolution — proven live by `agent-fable-runner-critic` — is that the
  **Regent spawns the reviewer as an ad-hoc Agent**
  (`--bypass-preset-agent --model <reviewer>`), requested by the loop Alpha
  through the same `send-agent` path as a fixer request, supervisor set to
  the loop Alpha. This is the normal path for a heterogeneous-model loop
  running under a single-model routing preset — expect it, don't treat it
  as an escalation.
- **Admitted under no spawn shape at all:** refuse loudly before round 1,
  citing the exact registry evidence (`active_plan.rolePools` contents).
  Never discover this at round 1, as RFL originally did.

### 2. Reviewer quota — three states, per the Lord's live ruling

Query the live quota source for `REVIEWER_MODEL`. The result is one of
three states, never two — a binary sufficient/insufficient check is the
exact bug the Lord caught live (the usage source returned HTTP 429 mid-RFL,
quota could not be confirmed, and `create-agent` proceeded anyway because
only *fresh confirmed* exhaustion blocks a model):

| State | Rule |
| --- | --- |
| **Sufficient** | Proceed. Size the round cap against the remaining quota — never exceed what the confirmed remaining quota supports, even if the round-cap precedent below would allow more. |
| **Insufficient** | Refuse loudly, naming the model and the remaining amount. Never silently substitute a different model and call the result a review by the requested one. |
| **Quota-unknown** (source errored, e.g. 429, or returned no reading) | Treat as **blocking-pending-retry** — NOT as sufficient. A loop that guesses sufficient on an unknown reading can discover real exhaustion three rounds deep with half-finished fix work already landed. Retry the live quota source a small bounded number of times (3 attempts, short backoff). If still unknown after the bounded retry, escalate to the Regent as a genuine blocker — this is not a decision the loop Alpha may make unilaterally by guessing. |

### 3. Delivered-contract context bundle

Before round `01a`, the invoker or the loop assembles the "already decided
/ already fixed" context: settled decisions, prior critique, constraints
that are not up for re-litigation. This exact bundle is included in **every
single review round's prompt**, not just round 1 — RFL's brief had to hand
its reviewer this list or burn whole rounds re-litigating rulings the Lord
had already made.

## Reviewer spawn authority stays with the Regent — a stated prohibition, not a suggestion

Direct Lord ruling, observed live while unblocking RFL (Source turn 2):

> "that is indeed the correct way to spawn fable as alphas have a tendency
> to bypass for no good reason."

**The loop Alpha never spawns a reviewer or a fixer itself.** Every spawn —
reviewer or fixer — is a `send-agent` request TO the Regent, naming what is
needed and why; the Regent decides whether and how to spawn it. The loop
Alpha carries **zero** bypass authority: it never passes
`--bypass-preset-agent`, `--bypass-effort`, or `--bypass-alpha-guardrail` on
any spawn request it makes, because it has no standing to use those flags at
all — they are Regent-only judgment calls. Concentrating bypass authority in
the one agent with a view of the whole board and the quota turns each bypass
into a deliberate decision instead of a reflex by the agent most
inconvenienced by the gate.

If a spawn request comes back refused, the loop Alpha reports the refusal
upward and asks again or escalates to the Regent — it does not look for a
flag that routes around the refusal.

## Loop shape and the three termination bounds

Alternate reviewer rounds and fixer rounds:

- `NNa_review` — the reviewer (Agent or Alpha/Shadow per the pre-flight
  resolution above), read-only against `TARGET_REPO`, receives the
  delivered-contract context bundle plus the immediately preceding round's
  fix outcome. Ranks findings **ACTIONABLE** vs **NIT**. States what it
  re-checked from the prior round.
- `NNb_fix` — a fixer Alpha (see "Fixer request contract" below)
  implements the immediately preceding round's ACTIONABLE findings only.
  May decline a finding with recorded evidence rather than silently
  dropping it.

**All three termination bounds are mandatory. First to fire wins. The
report states which bound fired — the loop's single most informative
fact.** None of the three may be individually disabled or weakened by the
invoker: "loop until clean" does not terminate, because a competent
reviewer always finds something and polish is infinite.

1. **Hard round cap.** A number the invoker/loop sets before round 1 (RFL
   used 5 — cited here as precedent, not a constant this skill hardcodes).
   On reaching it: stop, record what was left undone.
2. **Severity gate.** A review round ranks findings ACTIONABLE vs NIT. A
   nits-only or empty round counts as **zero** actionable findings and
   exits — wording preference, subjective styling, and speculative
   refactors never keep the loop alive.
3. **No-progress stop.** A round's actionable findings substantially repeat
   the immediately prior round's → exit. Two rounds of the same complaint
   is a signal the fix did not take or the reviewer is circling, not an
   invitation to a third round.

## Round numbering

`NNa_review`, `NNb_fix`, then the next round increments the letter:
`01a_review`, `02a_fix`, `01b_review`, `02b_fix`, `01c_review`, ... —
mirroring RFL's actual ledger shape, so the history reads in order rather
than overwriting itself.

## The loop Alpha's worktree is read-only

The loop orchestrates writers; it never writes code itself. Its own branch
stays empty, so its terminal slice runs **no delivery gate chain** —
`merge-git-tree` on an empty diff is ceremony, not verification.

Name the temptation explicitly and forbid it: a one-line finding (a copy
string, a missing prop) still makes requesting a whole fixer Alpha feel
absurd. It is requested anyway — batched into the next round's fixer
request if truly trivial — **never hand-edited in the loop Alpha's own
worktree.** An ungated, unverified, unrecorded "quick fix" is the exact
breach that put `main` red for the whole court on 2026-08-08.

## Fixer request contract

The fixer is an Alpha, requested from the Regent via `send-agent` — never
spawned by the loop Alpha itself. The request carries, every time:

1. **Proposed name** — ≤32 characters (Herdr refuses longer).
2. **Target repo** — `TARGET_REPO` from the input contract.
3. **The round's ACTIONABLE findings, verbatim** — the new Alpha inherits
   no context from the loop; paraphrasing loses precision the reviewer
   spent a round establishing.
4. **What was triaged OUT as nits** — so the fixer cannot widen scope into
   them under the cover of "while I was in there."
5. **Supervisor = the loop Alpha, explicitly, never the Regent.** Default
   it to the Regent and the loop never receives the fixer's DONE, is never
   woken by it, and cannot sequence its own next round — the review→fix
   loop silently degrades into a one-way feedback line.

Use `templates/fixer-request.md` (see "Template rendering contract" below)
to render this request before sending it.

## Reviewer request contract

When the pre-flight resolves the reviewer as an ad-hoc Agent
(`--bypass-preset-agent --model <reviewer>`) or as a normal Alpha/Shadow
spawn, the loop Alpha's request to the Regent carries: the reviewer model
and effort, `TARGET_REPO`, the delivered-contract context bundle, the
immediately preceding round's fix outcome (empty for round `01a`), and the
resolved spawn shape from pre-flight step 1. Use
`templates/reviewer-request.md` to render it. The reviewer's own round
prompt — what it is actually asked to do once spawned — is rendered from
`templates/review-round-prompt.md`.

## Template rendering contract

Render templates mechanically into the target agent's ASSIGNMENT.md path
(or inline into the `send-agent` request to the Regent when no separate
worker reads the assignment itself — a reviewer/fixer request TO the Regent
is a request, not an assignment file). Before sending any rendered text,
verify it is nonempty and contains no unresolved uppercase placeholder:

```bash
if rg -n '\{\{[A-Z][A-Z0-9_]*\}\}' "$rendered_path"; then
  echo "review-loop: unresolved template placeholder" >&2
  exit 1
fi
```

The three templates have these exact `{{TOKEN}}` interfaces — every token
below must be resolved before the template is sent:

- `templates/reviewer-request.md` — the loop Alpha's `send-agent` request to
  the Regent asking it to spawn a reviewer. Tokens: `{{LOOP_ALPHA}}`,
  `{{TARGET_REPO}}`, `{{REVIEWER_MODEL}}`, `{{REVIEWER_EFFORT}}`,
  `{{SPAWN_SHAPE}}` (one of `normal role-pool spawn` or `Regent ad-hoc Agent
  (--bypass-preset-agent --model <reviewer>)`), `{{ROUND_LABEL}}` (e.g.
  `01a_review`), `{{CONTEXT_BUNDLE}}`, `{{PRIOR_FIX_OUTCOME}}` (literal
  `none — round 01a` for the first round).
- `templates/fixer-request.md` — the loop Alpha's `send-agent` request to
  the Regent asking it to spawn a fixer Alpha. Tokens: `{{LOOP_ALPHA}}`,
  `{{PROPOSED_NAME}}` (≤32 chars), `{{TARGET_REPO}}`, `{{ROUND_LABEL}}`
  (e.g. `02a_fix`), `{{ACTIONABLE_FINDINGS}}` (verbatim from the review
  round), `{{TRIAGED_OUT_NITS}}`.
- `templates/review-round-prompt.md` — what the spawned reviewer is actually
  asked to do; the loop Alpha hands this to the Regent as the body of the
  reviewer's task, or the ad-hoc Agent's initial instruction. Tokens:
  `{{TARGET_REPO}}`, `{{ROUND_LABEL}}`, `{{CONTEXT_BUNDLE}}`,
  `{{PRIOR_FIX_OUTCOME}}`, `{{OBJECTIVE}}`.

## Termination report

On exit — whichever bound fired — the loop Alpha's terminal report states,
by name: which of the three bounds fired (hard round cap / severity gate /
no-progress stop), the full round history (each round's findings and each
fixer round's done/skipped-with-reason outcome), and any residual
ACTIONABLE findings left undone at a hard-cap exit for a future campaign to
pick up. No delivery gate chain runs on the loop Alpha's own terminal slice
(see "The loop Alpha's worktree is read-only" above) — its own diff is
always empty.

## Out of scope

This skill does not migrate `alpha-rfl-review-fix-loop` onto itself, and
does not touch RFL's ledger or brief. It does not touch
`src/no-idling/`, `send-agent`, or `keep-going` — SAKEY owns that surface;
report a collision to the Regent rather than working around it.
