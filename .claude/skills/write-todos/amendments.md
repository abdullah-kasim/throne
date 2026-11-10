# Mid-flight amendments — the one reconciliation contract

Steering arrives after authoring has started and after execution has started.
This section is the single normative home for what happens then; `execute-todos`
and `write-and-execute-todos` bind to it, add no exception, and define no
alternative lifecycle. Each of them states only the operational obligations its
own phase needs; wherever such a phase summary is thinner, this contract governs.

**A direct user amendment is a source turn.** Any later user instruction that
arrives through the chat or steering channel and changes the objective, scope, or
acceptance is appended verbatim as the next ordered source turn in
`00_overview.md` — never paraphrased into a summary, never edited into an earlier
turn, never carried only in an agent's prose report or head. This holds whether
it lands during authoring or mid-execution.

**Only a direct Lord amendment may expand an active bundle.** A Regent message
may append scope only when it relays the Lord's exact wording verbatim and keeps
that direct-Lord provenance explicit. Regent may clarify existing requested
scope and coordinate the minimum correction of a candidate-caused regression or
a defect demonstrably blocking the requested outcome; those actions do not add
new acceptance scope. A numbered queue amendment recorded with
`throne amendment` carries the Lord's verbatim words with their provenance, so
it has the same standing as a Regent relay of them, whichever of a Stager or
the Regent recorded it. It reaches the Alpha as a short pointer message, and
every amendment recorded before launch is listed in full under
`## Situation at launch` in the opening prompt; fold each one in as a source
turn during authoring. A Regent-originated feature, unrelated bug, robustness
goal, cleanup outcome, or new acceptance criterion is a separate finding: queue
it as a separate objective with a new Alpha, and never append it to the active
bundle.

**Append and reconcile before the affected work continues.** The append plus the
reconciliation below happens BEFORE any further work in the area the amendment
touches, and before an authoring bundle is handed to execution. Unaffected slices
keep running; nothing pauses that the amendment does not touch.

**Supersession is clause-scoped.** Mark the corrected ledger row
`superseded by Source turn N` and keep it; add the amending clause as its own
row. Earlier source turns and their rows are never deleted or rewritten, so the
record of what the user originally asked for survives every correction.

**A question-log answer is never a source turn.** Answers the user writes into
`000_current_questions.md` are a separate reconciliation channel. They stay in the
question log — they are never promoted, copied, or appended into the ordered
source turns, and they never renumber or restate a source turn, even when the
answer changes an execution decision. Their effect reaches the bundle only
through the named-surface reconciliation rule below, which treats an answered
question exactly like an amendment for reconciliation purposes while leaving the
source-turn record untouched. The two channels never merge: chat/steering
instructions become source turns, question-log answers do not.

**Reconcile every named surface, then stamp freshness.** The surfaces are:
`00_overview.md`'s source turns, clause ledger, `## Scope and boundaries`,
`## Done when`, and `## Traceability`; and every affected numbered slice. Unstarted slices are rewritten in place;
work already landed or in flight that the amendment contradicts earns a new
numbered corrective slice rather than a silent edit to landed work. An answered
question drives this same surface sweep, and records its reconciliation by citing
the answered question's own entry — it never advances the source-turn count.
Finish by setting `**Amendments reconciled through:** Source turn N` to the
highest-numbered recorded turn. When any of those turns came from a numbered
queue amendment, also set `**Queue amendments reconciled through:** <n>` to the
highest amendment number reconciled. That line is read by code:
`throne check-queue-amendments-reconciled` compares it with the queue row, and
the push guard and `merge-git-tree` refuse delivery while it is lower than the
row's highest amendment.

**A late amendment staleness-kills a terminal PASS.** An amendment recorded
after `99a` or `99b` has already passed makes that PASS stale: completion
requires a fresh real Shadow re-run of every terminal gate the amendment
invalidates — `99a` whenever the amendment changes what was asked for, `99b`
whenever it changes code — over the amended bundle, before any `99c`
delivery.
