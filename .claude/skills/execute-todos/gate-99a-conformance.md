# The 99a conformance gate

#### `99a` waits for the ticket-alignment check

A bundle whose `00_overview.md` stamps `ticket:` (the planner stamps it
whenever the queue row carries a `TICKET:` block or the tasking names a
ticket) carries a `98_ticket_<topic>.md` todo that depends on every ordinary slice. Its fresh
Shadow runs `/ticket-check` on the candidate, passing the queue row's
`RULINGS:` and every recorded amendment as its rulings, and ends its execution
log with exactly one `**Ticket alignment outcome:** PASS` or
`**Ticket alignment outcome:** FAIL`. It also writes `ticket-warning.md` into
the bundle folder: the DIFFERENT BY RULING lines and the warning block
`/ticket-check` printed, verbatim, or the single line `no warning needed`.
This skill calls `/ticket-check` and never restates its procedure.

- `99a` does not start until that todo records
  `**Ticket alignment outcome:** PASS`, and `99a` FAILs if the line is not
  PASS.
- A FAIL (a ticket line UNMET with no ruling behind it) is corrective work for
  the owning Alpha, exactly like a `99a` FAIL: one consolidated corrective
  slice, then a fresh `98_ticket_` Shadow re-runs the check.
- `bin/git` already refuses the Alpha's push until `99a` records
  `**Conformance outcome:** PASS`, so it enforces the ticket check with no
  change of its own.

#### `99a` — grade the candidate against what was literally asked for

`99a_conform_<topic>.md` runs first, after every ordinary slice has landed and
the tree is quiescent. It is a fresh real Shadow, and it is a VERDICT gate: it
writes no product code, commits nothing to the campaign branch, and its empty
diff is the expected shape.

**The standard is literal, and it is the request, not the plan.** Reconstruct it
by quoting the queue row's `INTENT:`, `SCOPE:` and `RULINGS:` and
`00_overview.md`'s `## Done when`, then every recorded addendum since. If the
Lord said `./install.sh` installs the app and leaves him able to open a
`.desktop` file, the objective is unmet until the gate has run `./install.sh`,
shown the `.desktop` file exists, and shown that file actually launches the
installed application. "The installer exits 0" is a different claim. "We
implemented installation" is not a claim at all.

**Only a recorded addendum moves the standard.** An errata entry, an explicit
Lord ruling, or a queue-row amendment relaxes or redirects a requirement, and
the gate grades against the amended text. A slice's own view that a requirement
was unreasonable does not, and neither does an Alpha's decision to descope. An
unmet requirement with no addendum behind it is a FAIL.

**`99a` never waits on a human.** Where a claim genuinely needs eyes, it
exercises the closest machine-checkable proxy — run the entry point, assert the
artifact, parse it, invoke what it points at, confirm the process starts —
records the residual as UNPERFORMED in one line naming what a person would
confirm, and grades everything else. A claim it could not exercise AT ALL is
UNMET, not UNPERFORMED.

**`99a` reports; it does not repair.** Unlike `99b`, a gap it finds goes back as
a FAIL naming the unmet claim, quoting the requirement text, and stating what
evidence would have satisfied it. That is corrective work for the owning Alpha,
after which the chain re-runs `99a` fresh. Evidence is generated — command,
exit code, output — never reasoned about: reading the source and concluding it
must work is not evidence.

**A report skill's own gate rule is the one exception.** When the bundle runs a
report skill whose own SKILL.md defines its `99a` failure classes and re-gate
scope, the gate follows that skill. An engineering item FAILS the round: a
wrong figure, verdict, severity or recommended fix, or a check the skill
requires that was not done. A cosmetic or record slip never fails it: the gate
fixes it in place when a text or record edit inside the run's own diagnostics
dir and new report folder does it, and otherwise lists it as a note. After a
failed round the next `99a` checks only the failed items and what the
consolidated corrective slice's `changes.md` lists, plus the skill's validator
and copy check, not the whole report again. It is still one corrective slice
per failed round, still a brand-new worker for that slice and for every
re-gate, and the gate still commits nothing to the campaign branch. Every other
bundle, code campaigns included, keeps "`99a` reports; it does not repair" and
the fresh full re-gate, and until a skill defines that rule this exception does
nothing.

**`99a` also grades reuse.** For every entry under the queue row's `REUSE:`
marker and every row of the overview's reuse ledger, the gate checks the
candidate: the named primitive was extended or called, or the bundle records
concrete evidence (a missing guarantee, named) for not using it. A new
function whose body duplicates an existing one in the target tree is a FAIL
naming both, whatever the plan said. The check is mechanical where it can be:
`git diff <base>..<candidate> --name-only`, then
`npx jscpd@3.5.10 --silent --reporters json --output <dir> --format <languages> <tree>`
on the base and on the candidate, and any clone pair present in the candidate
report but absent from the base report is a new duplicate (jscpd 4 scans
nothing silently; use 3.5.10). Code reuse decreases complexity; a duplicate
that passed every test is still a defect.

When the bundle has a `98_ticket_` todo, `99a` reads that todo's file and
returns FAIL unless it carries `**Ticket alignment outcome:** PASS` on its own
line.

It ends with exactly one `**Conformance outcome:** PASS` or
`**Conformance outcome:** FAIL`. `99b` runs only after an explicit PASS.
