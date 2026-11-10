# The 99d record step

#### `99d` — record the outcome on the Lord's page

Every bundle ends with one more todo after `99c`: `99d_record_<topic>.md`,
"record the outcome on the Lord's page". The page is `where-i-stand.md` under
the throne data home, the one file the Lord reads to see what he is working
on. Only agents write it: one entry with `throne where-i-stand put`, a
correction across several entries with their harness's edit tool while they
hold `throne where-i-stand lock`. `/where-i-stand` holds both flows, the
frame and the writing rules.

**The Alpha performs this step itself. It is not a gate.** `99a`, `99b` and
`99c` remain real, fresh Shadows. `99d` grades nothing and changes no code,
so an independent reader would add nothing to it, and the entry is the
campaign's own words about its own work. Spawn no Shadow for it.

Its place in the order is fixed, because the check below compares the time
the entry was written with the time `REPORT.md` was written:

1. `99c` reports `**Delivery outcome:** PASS`.
2. You send the release requests "After the PASS" lists and wait for each
   reply.
3. You write `REPORT.md`.
4. You perform this step.
5. You report DONE to your supervisor.

The step itself:

1. Move your entry `### <objective code>` out of `## In flight` with
   `throne where-i-stand put --code <objective code> --section "<section>" --text-file <file>`:
   to `## On GitHub` when the work has a pull request on GitHub, otherwise to
   `## Delivered, not on GitHub`. `put` takes the page's edit lock for that
   one write, replaces the entry wherever it stands, and prints the new
   checksum.
2. The file holds the entry's body, the lines under its heading. Its first
   lines are the page's entry form, as the where-i-stand skill's "Writing rules for the page" gives it: `- Links: …`, `- Kind: …`,
   `- Where it stands: …`. Then give it one honest line on what is and is
   not verified, and end it with the line naming who wrote it and when.
3. Correct every other entry about the same work. Steps 3 and 4 are the
   only edits that need the lock by hand: when either has something to do,
   run `throne where-i-stand show`, read the page at the path it prints,
   run `throne where-i-stand lock --checksum <checksum> --ttl 5m` in the
   background with your harness's own background run (the where-i-stand
   skill's step 4), and edit one entry at a time with your harness's edit
   tool, never a whole-file rewrite. Two entries are about the
   same work when their `- Links:` lines name the same Forgejo or GitHub pull
   request (a Forgejo pull request and its GitHub twin are the same work), or,
   when neither has a pull request, the same ticket and the same commit or
   branch. When your own entry carries only one of the Forgejo and GitHub
   links, look up the other with
   `throne forge status <pull request url> --json` (its `mergeTarget`) and
   write both, so the page itself ties the twins together. For each other entry about the same work, either:
   - remove it, when your entry now says everything it said; this is the
     default when the older row's work was absorbed or superseded by yours;
     or
   - correct its `Where it stands:` and state lines to the new truth and add
     one line ``Superseded by `### <objective code>` on <date>``.

   `throne check-where-i-stand` refuses while such an older entry stands
   uncorrected, naming the entry and the line to fix.
4. Remove any `## Needs you` line this delivery settled.
5. When you took the lock, stop it with your harness's own way to stop a
   background command, and read its output. When it names a broken heading,
   take the lock again and fix it. A lock refused at step 3 because the page
   changed since your `show` means another agent wrote in between: run
   `show` again, read the page again, and take the lock with the new
   checksum.
6. Add the note with
   `throne where-i-stand note "delivered <objective code>: <one line>"`.
7. Run `throne check-where-i-stand --agent <your-name>`. It must pass. Record
   its output in the `99d` file's execution log and in your DONE message.

Do not edit `REPORT.md` once the entry is written. The check asks for an
entry written after the report, so a later edit to the report puts the entry
behind it, and the check refuses until you write the entry again.
`complete-agent` asks the same check and refuses an Alpha's completion with
the check's own sentence while it fails, so a campaign that skips this step
cannot be completed. A campaign whose row was abandoned passes without an
entry.

**The earlier writes are duties, not checks.** The same entry is yours from
the start. Move it to `## In flight` when you launch. When you block on
something only the Lord can settle, put an entry under `## Needs you` with
the question in one sentence and add a note. When you unblock, remove that
entry and add a note. Each of these writes starts the entry with the page's
entry form, as step 2 does. Nothing refuses a campaign that missed one of
these, so nothing but you keeps the page true while the work runs.
