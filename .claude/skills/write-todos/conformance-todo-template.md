# The conformance todo (`99a_conform_<topic>.md`)

Always the FIRST terminal executable todo and always a fresh real Shadow. It
exists because a bundle can be green on every test the campaign wrote for
itself and still not be the thing that was asked for. Tests grade the code
against the campaign's own understanding; this gate grades the campaign's
understanding against the request.

**The standard is literal.** Take what the Lord asked for — as recorded in the
queue row's `INTENT:`/`SCOPE:`/`RULINGS:` sections and in `00_overview.md`'s
`## Done when` — and check the delivered candidate against it word by word,
not in spirit. If he said `./install.sh` installs the app and leaves him able
to open a `.desktop` file, then the objective is unmet until you have shown
that `./install.sh` writes a `.desktop` file and that the file actually
launches the installed application. "The installer runs cleanly" is not that
claim. "We implemented installation" is not that claim.

**Addenda are the only thing that moves the standard.** A recorded amendment to
the bundle — an errata entry, an explicit Lord ruling, a queue-row amendment —
relaxes or redirects a requirement, and you grade against the amended text.
Nothing else does: not a slice's own opinion that a requirement was
unreasonable, not an Alpha's decision to descope, not a convenient reading. An
unmet requirement with no addendum behind it is a FAIL.

**This gate never blocks on a human.** It is a machine-checkable conformance
pass, not a request for someone to come and look. Where a criterion genuinely
needs human eyes, exercise the closest machine-checkable proxy — run the
installer, assert the file exists, parse it, invoke what it points at, check
the process starts — record the residual human half as UNPERFORMED in one line
naming what a person would need to confirm, and grade on everything else. The
Lord tests it himself afterwards; a false PASS wastes his time and an idle wait
wastes everyone's.

**It grades; it does not build.** This gate writes no product code and commits
nothing to the campaign branch. Its branch is legitimately empty and the throne
expects that (`isTerminalGateShadowName`). A gap it finds goes back as a FAIL
naming the unmet requirement and the evidence, which is corrective work for the
Alpha — unlike `99b`, which fixes what it finds.

**A ticket-driven bundle's `99a` waits on the ticket check.** When the bundle
has a `98_ticket_<topic>.md`, `99a`'s `deps:` include it, and `99a` FAILs
unless that todo's file carries `**Ticket alignment outcome:** PASS` on its
own line. The push guard already refuses delivery until `99a` records
`**Conformance outcome:** PASS`, so it enforces the ticket check with no
change of its own.

```markdown
---
deps: [<every ordinary slice, including 98_ticket_<topic> when it exists>]
---

# 99a — Grade <feature> against what was literally asked for

Fresh independent Shadow. You are not testing the code; you are testing whether
the code is the thing that was requested.

1. Reconstruct the standard. Quote the original request verbatim — the queue
   row's `INTENT:`, `SCOPE:` and `RULINGS:`, and `00_overview.md`'s
   `## Done when` checklist. List every addendum recorded since, and quote what
   each one changed. That quoted set, and nothing else, is the standard.
2. Turn it into a checklist of literal, observable claims. One line per claim,
   each phrased so it can be marked met/unmet with evidence.
3. Exercise the candidate against each claim. Run the actual entry point the
   requester named. Generate the evidence — command, exit code, relevant
   output — rather than transcribing it or reasoning about what it would do.
   Reading the source and concluding it must work is not evidence.
4. Mark each claim MET, UNMET, or UNPERFORMED (human-only residue), each with
   its evidence or its one-line reason.

## Out of scope

- Fixing what you find. Gaps are reported, not repaired — `99b` owns fixing,
  and it owns fixing test and lint failures, not unmet requirements. A bundle
  that runs a report skill whose own SKILL.md defines its `99a` failure classes
  and re-gate scope writes this gate to that skill's rule instead, as
  execute-todos' `99a` section states under "A report skill's own gate rule is
  the one exception."
- Test and lint execution as such. That is `99b`'s job; you may run them for
  context but a green suite is not evidence of conformance.
- Judging whether the requirement was wise. It was asked for; that settles it.

## Deliverable

- End with exactly one `**Conformance outcome:** PASS` or
  `**Conformance outcome:** FAIL`.
- PASS requires every claim MET or UNPERFORMED-with-reason, with evidence
  cited per claim. A claim you could not exercise at all is UNMET, not
  UNPERFORMED — UNPERFORMED is only for the human-eyes residue of a claim you
  otherwise proved.
- FAIL names each unmet claim, quotes the requirement text it comes from, and
  states what evidence would have satisfied it. Never a vague "does not meet
  the objective".
- When this bundle has a `98_ticket_<topic>.md`, FAIL unless that file carries
  `**Ticket alignment outcome:** PASS` on its own line.
- Your branch carries no product commits. That is the expected shape.
- When you end a turn to wait on background work you started (a test or
  suite run, a monitor, a queued container slot, a background agent), end
  that message by running `throne my-state waiting-on-own-run "<what>"` and publishing
  `{"blocked":true} BLOCKED_BY_own-background-run (<what>)`; your next prompt records
  you as working again. Otherwise no-idling pages the Regent every minute.
```
