# The ticket-alignment todo (`98_ticket_<topic>.md`)

Present only in a ticket-driven bundle: the queue row carries a `TICKET:`
block, or `00_overview.md` stamps `ticket:`. It exists because `99a` grades
the candidate against the queue row, which is one reader's account of the
ticket; a misread or narrowed ticket passes `99a` untouched. This todo grades
the candidate against the ticket's own words.

It is a fresh real Shadow and **verdict-only**: spawned with
`--deliverable-shape verdict-only`, it writes no product code and commits
nothing, so its empty branch is expected. Its `deps:` name every other
ordinary slice, so it runs after all of them and before `99a`. It runs the
global `/ticket-check` skill on the campaign branch candidate, passing as
rulings the row's `RULINGS:`, every queue amendment, and every source-turn
amendment in `00_overview.md`. It calls `/ticket-check` and never restates
its procedure.

Two outputs leave it. Its execution log ends with exactly one line,
`**Ticket alignment outcome:** PASS` or `**Ticket alignment outcome:** FAIL`.
And it writes `ticket-warning.md` into the bundle folder, holding either
`/ticket-check`'s DIFFERENT BY RULING lines plus its warning block verbatim,
or the single line `no warning needed`; `99c` reads that file when it writes
the pull request body.

A FAIL (a ticket line UNMET with no ruling behind it) is corrective work for
the Alpha, exactly like a `99a` FAIL: one consolidated corrective slice, then
a fresh `98` Shadow re-runs, and `99a` does not start until it passes.

```markdown
---
deps: [<every other ordinary slice>]
---

# 98 — Check <feature> against the ticket

Fresh independent Shadow, verdict-only. You are not grading the code against
the queue row; you are grading it against the ticket.

1. Run the global `/ticket-check` on the campaign branch candidate for the
   ticket `00_overview.md` stamps in `ticket:`. Pass as its rulings the queue
   row's `RULINGS:`, every queue amendment, and every source-turn amendment in
   `00_overview.md`, each quoted in full.
2. Write `ticket-warning.md` into this bundle folder: `/ticket-check`'s
   DIFFERENT BY RULING lines and its warning block verbatim, or the single
   line `no warning needed` when it reports none.

## Out of scope

- Fixing what you find. An UNMET ticket line is corrective work for the Alpha.
- Grading against the queue row alone. That is `99a`'s job.

## Deliverable

- End with exactly one `**Ticket alignment outcome:** PASS` or
  `**Ticket alignment outcome:** FAIL`, as `/ticket-check` decides it.
- FAIL names each ticket line left UNMET with no ruling, quoting the ticket.
- `ticket-warning.md` exists in the bundle folder either way.
- Your branch carries no product commits. That is the expected shape.
```
