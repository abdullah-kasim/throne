# Question-log template — `000_current_questions.md`

This is the **required** format for the question log that `/execute-todos` keeps (SKILL.md
rule 5). It covers **every** decision the todo left unpinned — **blocking and non-blocking
alike**. When a slice subagent hits one, it first tries hard to answer it from the code /
specs / schematics / `00_overview.md`, then appends ONE entry in this exact shape to
`000_current_questions.md` in the bundle folder, records a best-judgment default, and proceeds
— it never halts the queue to wait, even for a blocking decision. The user answers back in the
same file out of band, and the run reconciles when they do.

**Orchestrator:** paste the absolute path to THIS file into every slice subagent's prompt
and tell it to follow the format verbatim. The single most important rule: **every entry
ends with a blank `**User answer:**` line** — that blank line is the user's input slot.
Without it, the user has nowhere to type their override and the log is useless to them.

---

## File header (write once, at the top of `000_current_questions.md`)

```markdown
# Open questions — <bundle name> (for the user)

Decisions surfaced during execution — blocking and non-blocking. Each carries a
best-judgment answer so the run could continue; fill in **User answer:** on any to override.
```

## One entry per decision (append in order)

```markdown
## Q<N> — <one-line question> (slice NN)

**Question:** <full question + the ambiguity that prompted it>
**Assumed answer:** <the decision you ran with, and why — the default in effect>
**Reversible?** <yes/no — how costly to undo if the user overrides it later>
**Status:** assumed (user may override)
**User answer:**
```

### Rules
- ALWAYS emit the `**User answer:**` line and ALWAYS leave it EMPTY (nothing after the
  colon). It is the user's slot — do not pre-fill it, do not delete it, do not put a
  placeholder like "N/A" there.
- Number entries `Q1, Q2, …` **per bundle, contiguous across slices** — read the file
  first to find the next free number; do NOT restart at Q1 in a later slice.
- Use it for genuine decision points (scope, contract shape, naming, ordering), not for
  trivia you can settle from the code.
- Flag irreversible decisions loudly: `**Reversible?** no — <why undoing is costly>`.
- A pure FYI with no real question still uses the same shape — phrase `Question:` as
  "Confirm: <the call I made>?" so it still carries a `User answer:` slot.

## When the user fills in an answer (orchestrator, or a later reconciliation pass)
Treat the user's `**User answer:**` text as authoritative. Update that entry's
`**Status:**` to `RECONCILED — applied` with a one-line note of what changed, and leave
the user's `**User answer:**` text exactly as they wrote it. Reconcile any work already
done against the assumed answer: re-do the reversible bits, flag the irreversible ones.

## Filled example

```markdown
## Q3 — Provisional settle defaults for the arc-prevention sequencer (slice 01)

**Question:** The upstream sensor's gate-drive and coil specs aren't in hand, so the FET/relay
settle delays can't be pinned. What defaults should ship?
**Assumed answer:** `FET_SETTLE = 50 ms`, `RELAY_SETTLE = 100 ms` (relay larger to cover
coil pull-in + bounce). Conservative placeholders, overridable via `SettleDelays`.
**Reversible?** yes — single consts, one-line change once measured at bring-up.
**Status:** assumed (user may override)
**User answer:**
```
