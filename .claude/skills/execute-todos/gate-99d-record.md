# The 99d record step

#### `99d` — record the outcome on the Lord's page

Every bundle ends with one more todo after `99c`: `99d_record_<topic>.md`,
"record the outcome on the Lord's page". The page is the one the Lord reads to see
what he is working on, kept in the throne database. Agents write it only
through commands: `throne where-i-stand list` before any add, then `put` by
section id with the listing token, `archive` and `restore` in place of
removing, and `note` for events. `/where-i-stand` holds the commands, the
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

1. Run `throne where-i-stand list` and keep its section ids and listing
   token. Move your entry `### <objective code>` out of `## In flight` with
   `throne where-i-stand put --code <objective code> --section-id <id from list> --listing-token <token from list> --text-file <file>`:
   to `## On GitHub` when the work has a pull request on GitHub, otherwise to
   `## Delivered, not on GitHub`. `put` replaces the entry wherever it
   stands. When it refuses a stale token, list again and use the new one.
2. The file holds the entry's body, the lines under its heading. Its first
   lines are the page's entry form, as the where-i-stand skill's "Writing rules for the page" gives it: `- Links: …`, `- Kind: …`,
   `- Where it stands: …`. Then give it one honest line on what is and is
   not verified, and end it with the line naming who wrote it and when.
3. Correct every other entry about the same work. Read the page with
   `throne where-i-stand show`; it is read-only, and every correction is a
   command. Two entries are about the
   same work when their `- Links:` lines name the same Forgejo or GitHub pull
   request (a Forgejo pull request and its GitHub twin are the same work), or,
   when neither has a pull request, the same ticket and the same commit or
   branch. When your own entry carries only one of the Forgejo and GitHub
   links, look up the other with
   `throne forge status <pull request url> --json` (its `mergeTarget`) and
   write both, so the page itself ties the twins together. For each other entry about the same work, either:
   - archive it with `throne where-i-stand put --code <its code> --remove`,
     when your entry now says everything it said; this is the
     default when the older row's work was absorbed or superseded by yours;
     or
   - correct its `Where it stands:` and state lines to the new truth and add
     one line ``Superseded by `### <objective code>` on <date>``, with
     `put` under its own code.

   `throne check-where-i-stand` refuses while such an older entry stands
   uncorrected, naming the entry and the line to fix.
4. Remove any `## Needs you` line this delivery settled, with `put --remove`
   or `archive`.
5. Add the note with
   `throne where-i-stand note "delivered <objective code>: <one line>"`.
6. Run `throne check-where-i-stand --agent <your-name>`. It must pass. Record
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
the question in one sentence and add a note. When you unblock, archive that
entry and add a note. Each of these writes starts the entry with the page's
entry form, as step 2 does. Nothing refuses a campaign that missed one of
these, so nothing but you keeps the page true while the work runs.
