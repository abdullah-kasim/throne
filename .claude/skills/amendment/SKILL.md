---
name: amendment
description: 'This throne-only skill records the Lord''s amendment to a queue row with `throne amendment`, which numbers it, stores it beside the row, and tells the row''s in-flight Alpha and the Regent. Use it whenever the Lord changes, adds to, or corrects work that is already filed, including "amend that", "tell the campaign", "also make it do X", "change the ruling", or a mid-flight correction to a queued objective. Only a Stager or the Regent may run it, and only with the Lord''s own words.'
version: 1.0.0
user-invocable: true
---

# Amend a filed queue row

A change to filed work is only real once three things are true: it is written
beside the row, every agent that must act on it has been told, and delivery
cannot happen until the plan has absorbed it. `throne amendment` does all three
in one step. `update-queue --append-body` does only the first; it tells nobody
and nothing checks it later.

## Who and whose words

- Run it as a Stager or as the Regent. Every other role is refused.
- `--words-of` names whose words the amendment carries. Only the Lord's own
  words may change a campaign. Quote him; paraphrase only to fix grammar, and
  keep the exact phrasing of any ruling.

## Run it

```bash
throne amendment --objective-code <code> --words-of Lord --text-file <file>
```

Use `--text "<text>"` for a one-liner. Write the file the same way as a queue
body section: what changes, what it replaces, and the Lord's quoted words.

## What it does, by the row's state

| Row state | Result |
| --- | --- |
| open or deferred, not launched | Recorded. The Alpha receives every recorded amendment in its launch situation brief. Nobody is messaged. |
| in flight, work not finished | Recorded, then a short pointer goes to the row's Alpha and to the Regent (the Regent is skipped when it is the caller). |
| delivered, complete, abandoned, or its Alpha already wrote `REPORT.md` | REFUSED, nothing recorded. File a new objective against the delivered branch with `/queue-objective`. |
| no such row | REFUSED. File a new objective instead. |

Exit codes: `0` recorded and everyone told; `1` refused; `2` recorded, but
someone was not told. On `2`, read the error, then tell the named recipient
yourself with a short `throne send-agent` that points at the amendment number.

Shadows are never messaged. The Alpha owns its plan and passes changes to its
Shadows under the write-todos amendment contract.

## What the Alpha must do with it

Read it with `throne render-queue --status in-flight`, add it to the plan as a
source turn, reconcile every affected surface, and record the line

```text
**Queue amendments reconciled through:** <n>
```

in `00_overview.md` (in `verify.md` for a sliceless campaign). Pushing and
landing are refused while that number is below the row's highest amendment:
the push guard and `merge-git-tree` both run
`throne check-queue-amendments-reconciled --agent <alpha>`.

## Check before you run it

Look at the row first: `throne render-queue --all`. If its Alpha has already
said it is done, the amendment would never be read, and the command will
refuse. That is the signal to file a new objective, not to retry.
