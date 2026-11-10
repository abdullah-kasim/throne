# The record step (`99d_record_<topic>.md`)

The bundle's last file. It is not a gate and no Shadow runs it: the Alpha
performs it itself, after `99c` has passed, every release request is
answered and `REPORT.md` is written, and before it reports DONE. `99c` stays
the last todo a Shadow executes. `/execute-todos`
"`99d` — record the outcome on the Lord's page" owns the procedure and its
place in the order; the todo carries the campaign's own facts so the Alpha
does not have to look them up. Write the objective code, the Alpha's name
and the delivery target into the todo verbatim.

```markdown
---
deps: [99c]
---

# 99d — Record the outcome of <feature> on the Lord's page

Performed by the Alpha itself, after `99c` reports
`**Delivery outcome:** PASS`, after every release request is answered, and
after `REPORT.md` is written. No Shadow is spawned for this todo.

1. Move the entry `### <objective code>` out of `## In flight` with
   `throne where-i-stand put --code <objective code> --section "<section>" --text-file <file>`:
   to `## On GitHub` when the work has a pull request on GitHub, otherwise
   to `## Delivered, not on GitHub`. Start it with the
   page's entry form from the where-i-stand skill's "Writing rules for the
   page": its `- Links: …`, `- Kind: …` and `- Where it stands: …` lines.
   Then one honest line on what is and is not verified. End it with who
   wrote it and when.
2. Correct every other entry about the same work: the same Forgejo or GitHub
   pull request (a Forgejo pull request and its GitHub twin are the same
   work), or, with no pull request, the same ticket and the same commit or
   branch. When the entry carries only one of the two links, look up the
   other with `throne forge status <pull request url> --json` (its
   `mergeTarget`) and write both. Remove each such entry when this entry now
   says everything it said, which is the default when its work was absorbed
   or superseded; otherwise correct its `Where it stands:` and state lines
   and add one line ``Superseded by `### <objective code>` on <date>``.
   Steps 2 and 3 alone need the lock by hand: `throne where-i-stand show`,
   read the page, run `throne where-i-stand lock --checksum <checksum> --ttl 5m`
   in the background (the where-i-stand skill's step 4), and edit one entry
   at a time with the harness's edit tool, never the whole file.
3. Remove any `## Needs you` line this delivery settled.
4. When you took the lock, stop it and read its output. When it names a broken
   heading, take the lock again and fix it. Then
   `throne where-i-stand note "delivered <objective code>: <one line>"`.
5. `throne check-where-i-stand --agent <alpha-name>` must pass. Do not edit
   `REPORT.md` after this step: that would put the entry behind the report.

## Out of scope

- Any code change. A check that fails here for a reason other than a missing
  entry, an entry still in `## In flight`, an entry that does not start with
  its links line, or an older entry about the same work left uncorrected is
  a defect to report, not something to work around.

## Deliverable

- The page holds `### <objective code>` outside `## In flight`, starting
  with its links, kind and where-it-stands lines, and with the line on what
  is not verified.
- No other entry about the same work is left uncorrected: each is removed
  or carries its ``Superseded by `### <objective code>` on <date>`` line.
- `throne check-where-i-stand --agent <alpha-name>` passes; its output is in
  this file's execution log and in the DONE message.
```

`99d_record_<topic>` keeps its role word as the gates do. No Shadow is named
for it, so the throne's gate classification, which reads Shadow names, never
meets it.
