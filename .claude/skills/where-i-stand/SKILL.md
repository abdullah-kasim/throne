---
name: where-i-stand
description: 'This throne-only skill points the Lord at the page of what he is working on: one Markdown file under the throne data home that agents write, served by the throne backend on the tailnet below a table of his pull requests, where the Lord adds, edits and removes his epics and reads everything else. Its answer in the terminal is the page''s link and nothing else; the page, the table and what changed sit in the browser. It then reads the forges, the queue and the live agents in the background, puts the differences on the page, corrects the page entry by entry, and checks that the tailnet page is up. Use when the Lord asks "where do I stand", "what am I working on", "what needs me", "how are my PRs going", "show me the page", or invokes /where-i-stand. It also holds the writing rules every agent follows when it edits that page.'
version: 1.6.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension where-i-stand` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Where I stand

The Lord reads one page to see what he is working on while many agents are
busy: `where-i-stand.md` under the throne data home
(`${THRONE_DATA_HOME:-$HOME/.throne}/where-i-stand.md`). Nothing generates
it. Agents write it as they file, launch, block and deliver work, so it is
already there when he asks. The Lord's own page edits are for epics only: he
adds, edits and removes them on the page's Epics tab, and every other tab is
read-only. This skill points him at it first and corrects it second.

Adding, moving, replacing or removing one entry is one command,
`throne where-i-stand put` (step 4). A correction across several entries is
a targeted edit of each, made with your harness's own edit tool while you
hold `throne where-i-stand lock`. Never rewrite the whole file, and never
write it with a shell redirect or a script: `put` and the lock keep the
previous copy and journal what changed.

## The page's frame

Seven second-level headings, always present, always in this order:

| Section | What it holds |
| --- | --- |
| `## Just happened` | One-line events, newest first, at most 15 |
| `## Needs you` | What only the Lord can settle, the question in one sentence |
| `## In flight` | Work an Alpha is doing now |
| `## Queued and deferred` | Rows filed and not yet launched |
| `## Delivered, not on GitHub` | Work that landed where no reviewer can see it yet |
| `## On GitHub` | Work with a pull request on GitHub |
| `## Epics` | The Lord's own big goals, written by hand |

Under the four work sections, from `## In flight` to `## On GitHub`, one
entry per piece of work. Its heading is exactly `### <objective code>`, or
`### <repository>#<number>` for a pull request that has no queue row.
Everything inside an entry is the writing agent's own words.

`## Epics` is different. One epic is a `### <title>` heading in the Lord's
words, with free notes under it, or none. It has no objective code and no
entry form, and `throne check-where-i-stand` and the same-work report leave
it alone. A page file written before this section existed gains it, blank
and at the end, on the next `show`, `lock`, `note` or `save`; nothing else
in the file changes, and the change is journaled with the writer
`where-i-stand`.

## The five steps

Do them in this order. The Lord has the link after step 1; steps 2 to 5
must never delay it.

### 1. Answer with the page's link

The Lord reads the page in his browser, not in your terminal. Run step 5's
check, and follow step 5 when it is not up. Then your answer
in the terminal is the page's link, `$page_url`, on one line and nothing
else. Add a second line only when the Lord must act before he opens it: the
page could not be served, or a host could not be read. Do not print the
page, do not summarize it, and do not wait for step 2.

Save the page for yourself:

```bash
throne where-i-stand show > ~/tmp/where-i-stand-page.md
```

`show` prints the page on standard output exactly as stored, and
`path: <page path>` and `checksum: <sha256>` on standard error, so the
redirect saves the page alone and both lines still show in your pane. A page
nobody has written yet prints as the empty frame, with that frame's checksum.
This copy is for you, not for the Lord: step 3 compares against it. Step 4
edits the page itself, never this copy. Keep the path and the checksum: step
4 needs them.

### 2. Read, in the background, what the file cannot know

Start these with your harness's own background run of a command, so you can
keep talking while they work. Never put a shell `&` on them: a job detached
that way reports to nobody.

```bash
python3 "$THRONE_LIVE_ROOT/.claude/skills/where-i-stand/where_i_stand.py" --refresh --changes
python3 "$THRONE_LIVE_ROOT/.claude/skills/where-i-stand/where_i_stand.py" --cached --json
throne render-queue --all
throne agent-statuses
```

- The reader scans every pull request the Lord authored on github.com, on
  each host in his hosts file, and on each Forgejo host listed there.
  `--refresh` reads every host and updates the cache, `--changes` prints only
  the pull requests that are new, gone or changed since the cache, `--cached`
  answers from the cache without reading any host, and `--json` prints the
  raw records. Pass the same `--days` to every call.
- The same `--refresh` run, on github.com and each GitHub host in his hosts
  file, also reads two lists of other people's pull requests. Waiting for his
  review: the notification feed's review requests, kept only while the pull
  request is open, still asks him or one of his teams, and has no review of
  his in any state; each says whether it waits on him or on which team.
  His teammates' pull requests: the open ones the members of his `team` line's
  team opened in its organisation, updated inside `--days`. Both go into the
  cache and the page's data file, `--cached` and `--json` give them back, and
  `--changes` stays about his own pull requests. Forgejo is not read for
  either list: it holds no review requests for him.
- The `--refresh --changes` run also writes the page's data file,
  `${XDG_CACHE_HOME:-$HOME/.cache}/where-i-stand/where-i-stand-prs.json`:
  the pull request table, the time it was read, the hosts that could not be
  read, and the lines that changed since the last run. The page shows it
  above the agents' sections, and shows throne and dotfiles work, in the
  table and in the sections, in its own collapsed section at the end.
  `--cached` never writes it.
- From those records read each listed pull request's state: CI, reviews,
  merged, closed. Look also for pull requests of the Lord's that the page
  does not list.
- `throne render-queue --all` gives every queue row and its status;
  `throne agent-statuses` gives the agents that are live now.
- For one entry, skip the full scan:
  `throne forge status <pull request url> --json` gives that pull request's
  state on GitHub and on Forgejo.

Hosts and tokens stay in the Lord's own configuration, never in this
repository. The reader takes them from `~/.config/where-i-stand/hosts` (or
the file `WHERE_I_STAND_HOSTS` names): one line `<host> <command>` for a
GitHub host whose command accepts `gh`'s arguments, one line
`forgejo <root address> <token file>` for a Forgejo host, and at most one
line `team <host> <org>/<team slug>` per GitHub host naming the Lord's team
there, and any number of lines `owner <host> <owner>`: a GitHub host with
`owner` lines is searched for his pull requests in those owners only. A host
with no `team` line gets no teammates' list. Its cache lives
under `${XDG_CACHE_HOME:-~/.cache}/where-i-stand/`. A host that cannot be
read comes back under `problems`; say so instead of treating its pull
requests as gone.

### 3. Put the differences on the page

The differences go to the page, not the terminal. The table and its change
lines already show what step 2's run found new, gone or changed. Compare
what step 2 found with the page from step 1, and put every correction into
`where-i-stand.md` through step 4: a state the page has wrong, work the page
does not list, work that finished since the page last said otherwise.

When step 2 finishes, tell the Lord nothing more unless something now needs
him. Then write at most one line naming it, with the link again.

### 4. Correct the page, one entry at a time

Correct the page itself, at the path `show` printed. An edit tool replaces
only the exact text it is given, so an edit of one entry cannot drop an
entry it never touched; a whole-file rewrite can, which is why the page is
never rewritten whole.

To add, move, replace or remove one entry, run `put` and stop there:

```bash
throne where-i-stand put --code <objective code or repo#number> --section "<section name as on the page>" --text-file <file>
throne where-i-stand put --code <code> --remove
```

The file holds the entry's lines under its `### <code>` heading, starting
with the entry form; `--text "<entry body>"` takes them inline instead.
`put` writes the heading, removes every other entry with the same heading
from every section, takes the lock for its own write, journals you as the
writer and prints `checksum: <sha>`. It refuses an entry that does not start
with the entry form, naming the missing line, refuses while another agent
holds the lock, naming the holder, and refuses `## Epics`.

For a correction across several entries, take the lock and edit:

1. Read the page at that path with your harness's own file tool. When time
   has passed since step 1, run `show` again first and use its checksum.
2. Take the lock with your harness's own background run, never a shell `&`:

   ```bash
   throne where-i-stand lock --checksum <checksum from show> --ttl 5m
   ```

   It prints one line naming you and the time it lasts until, then waits.
   The lock is an OS lock on `where-i-stand.edit.lock` beside the page; it
   never blocks your edits, and the kernel frees it when the command ends,
   so that file never needs removing. It refuses at once, and leaves the
   page as it is, when the page changed since your `show`: run `show`, read
   the page again, and take the lock with the new checksum. It also refuses
   while another agent holds the lock, naming the holder and the time it
   lasts until: wait for that and try again. The default is 5 minutes and
   the most is `15m`.
3. While the lock lasts it is safe to edit. Make each correction as a
   targeted replacement with your harness's edit tool, one entry at a time:
   - fix every state step 2 showed to be wrong;
   - add what was missing, each as its own entry;
   - move finished work to the section it now belongs under;
   - remove an entry one day after its work merged or was abandoned;
   - trim `## Just happened` to its newest 15 lines;
   - write every entry you add or correct in the entry form "Writing rules
     for the page" gives;
   - remove or mark superseded every other entry about the same work as an
     entry you corrected, as "Writing rules for the page" says.

   This correction pass skips `## Epics`: the forges and the queue know
   nothing about it, so nothing they say corrects an epic.

   Never rewrite the whole file, and never cut the page apart by section
   heading with a script and put it back together.
4. Stop the background lock with your harness's own way to stop a background
   command, then read its output. It says what it journaled. When your edit
   broke the frame, it exits 3 instead of 0, names every heading that is
   missing, repeated, unknown or out of order, and the copy it kept before
   your edit; the page is left as it is, so take the lock again and fix those
   headings.
5. Add events with `note` only after the lock is stopped; a note is refused
   while any lock is held.

### 5. Keep the tailnet page up

The Lord also reads the page on his phone. The throne backend serves it on
127.0.0.1 only and publishes it at the path `/throne` with `tailscale serve`,
on the tailnet only, never through funnel, so the page is at
`https://<host>/throne/where-i-stand/`. The old address
`https://<host>/where-i-stand/` still works: it redirects there and keeps the
tab in its hash. Nothing here starts by hand. The backend publishes both paths
when it starts and again every minute, so they come back by themselves after
a reboot. Check them on every run:

```bash
tailnet_address="$(tailscale status --self --json | python3 -c 'import json,sys; print("https://" + json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
page_url="$tailnet_address/throne/where-i-stand/"
curl -s "$tailnet_address/throne/api/where-i-stand/page" | python3 -c 'import json,sys; json.load(sys.stdin)["markdown"]'
tailscale serve status | grep -F ' /throne '
```

Both commands exiting 0 means it is up; `$page_url` is the link step 1 answers
with, and you stop here. The first reads the page through the API and parses
it, because a bare `200` is fooled by any app published at `/`. The second shows
that the path is really the backend's.

When either fails, the remedy is the backend, not a server of your own:

- Read the backend's log, `journalctl --user -u throne-backend` on Linux and
  the `throne-backend` log under the throne home on macOS, for lines starting
  `[web-listener]` or `[tailnet-publishing]`. A failed bind or a missing
  tailscale is logged there and never stops the backend. Report what it says.
  When the backend itself is down, say so; it is what brings the page back.
- A line saying a path is `refused` means something this code did not create
  holds it. Report that path and its holder, and leave it. Never take a path
  over with `tailscale serve` by hand, and do not pick another path.
- The API reads the page from
  `${THRONE_DATA_HOME:-$HOME/.throne}/where-i-stand.md` and the data file from
  `${XDG_CACHE_HOME:-$HOME/.cache}/where-i-stand/where-i-stand-prs.json` on every
  request, so the page always shows the live files. Nothing is copied.
- Each file needs to exist. When `show` printed the empty frame because nobody
  had written the page yet, take step 4's lock and create the file at the path
  `show` printed with that frame, using your harness's file tool. When the data
  file is missing, run the reader once with `--refresh` (step 2), which writes
  it.

The same API answers the page's saves: `POST /api/where-i-stand/save` runs the
same code as `throne where-i-stand save`, takes the same lock, keeps the same
previous copy and journals the edit with the writer `Lord`. It refuses any save
that would change the page outside `## Epics`. Only the API saves from the page;
an agent never runs `throne where-i-stand save`.

## Writing rules for the page

These bind every agent that edits the page, whichever step or duty brought
it there.

- One entry is written with `put`; the lock and your edit tool are for
  corrections across several entries (step 4).
- `## Delivered, not on GitHub` trims itself on every `put`, `note`, lock
  release and save: it keeps its newest 20 entries and every entry younger
  than 3 days, and moves the rest whole to `where-i-stand.archive.md` beside
  the page. Never trim it by hand.
- Plain words. The Lord reads this between other things; write what a person
  outside the work would understand.
- No agent adds, edits, closes or removes an epic unless the Lord says so in
  words. A Stager he tells to add one edits `## Epics` under the lock, like
  any entry. The entry rules below are for work entries; an epic holds only
  its title and his notes.
- Every entry starts with its links, its kind and where it stands: directly
  under its `### ` heading, before any other line, these three lines in this
  form, because the page reads them to fill its table:

  ```markdown
  - Links: Forgejo <url or "no Forgejo copy"> · GitHub <url or "not on GitHub yet"> · Ticket <url, id, or "no ticket">
  - Kind: <a few words> — <title>
  - Where it stands: <short plain summary>
  ```

  A missing link is written as its short word, never left blank:
  `no Forgejo copy`, `not on GitHub yet`, `no ticket`. Work with no pull
  request writes its links line as
  `- Links: no pull request · <commit or link> · Ticket <url, id, or "no ticket">`.
  The separator is a space, a middle dot and a space (` · `). The
  ` — <title>` part of the `Kind:` line may be left out. The free lines
  follow: what is and is not verified, who wrote it and when.
- An entry for throne or dotfiles work with no pull request starts its
  `Kind:` line with `throne` or `dotfiles`, for example
  `- Kind: dotfiles — Shorter shell prompt`, so the page sorts it into its
  collapsed throne and dotfiles section.
- One line per fact. A state, a link, a question: each on its own line.
- One current entry per piece of work. Whoever records a newer state of
  some work, Stager, Regent or Alpha, removes every other entry about the
  same work, or corrects its `Where it stands:` and state lines and adds one
  line ``Superseded by `### <code>` on <date>`` naming the entry that now
  holds the truth. Remove it when the newer entry says everything it said.
  Two entries are about the same work when their links lines name the same
  Forgejo or GitHub pull request (a Forgejo pull request and its GitHub twin
  are one piece of work), or, when neither has a pull request, the same
  ticket and the same commit or branch.
  Releasing the edit lock and saving from the page both report every group
  of current entries about the same work, a `## Needs you` question beside
  its work's own entry excepted; the release then exits 3 and tells the
  Regent, while the save is kept.
- A link for every pull request. Never a bare number.
- Say what is not verified. An entry that names only what passed reads as
  finished work.
- Never copy a report into it. The page says where the work stands in a few
  lines and links to the rest.
- End each entry with a line naming who wrote it and when.
- Never start a line inside an entry with `## `. The command reads lines, not
  Markdown, so it refuses any second-level heading that is not one of the
  seven, and any of the seven used twice, even inside a code fence. Use `####`
  or bold text when an entry needs a label.
- A blocked row's entry goes under `## Needs you` and carries the question in
  one sentence the Lord can answer without opening anything.
- Events go through `note`, one line each, which also keeps the list at 15:

  ```bash
  throne where-i-stand note "delivered cakeorders: order page is on main"
  ```

  An event is one of: filed, launched, blocked, unblocked, delivered,
  promoted, merged, abandoned.

An invented entry, for a bakery's order page:

```markdown
### cakeorders

- Links: Forgejo https://git.example.com/bakery/storefront/pulls/12 · GitHub not on GitHub yet · Ticket https://tracker.example.com/issue/CAKE-41
- Kind: new page — Order page for the bakery
- Where it stands: open on Forgejo, CI green, no review yet.
- Customers pick a cake size and a pickup time.
- Verified: the order form's tests, and one order placed by hand on a phone.
- Not verified: card payments against the real payment service.
- Written by alpha-cakeorders-01 on 2026-01-05 at 14.20 UTC.
```

## Who writes, and when

The page stays true only because each role writes at its own moments.
AGENTS.md states each duty beside that role's other duties; this is the same
list in one place. Every entry this table names is written in the entry form
"Writing rules for the page" gives. A write of one entry is one
`throne where-i-stand put` (step 4).

| Role | Moment | What it writes |
| --- | --- | --- |
| Stager | files a row | an entry under `## Queued and deferred`, and a note |
| Stager | records an amendment that changes what the row is | the entry, corrected |
| Alpha | launches | its entry moves to `## In flight` |
| Alpha | blocks on something only the Lord can settle | an entry under `## Needs you` with the question in one sentence, and a note |
| Alpha | unblocks | the `## Needs you` entry goes, and a note |
| Alpha | delivers | its entry moves to `## Delivered, not on GitHub` or `## On GitHub`, every other entry about the same work is removed or marked superseded, and a note |
| Regent | abandons, defers or releases a row | the entry, corrected or moved, and a note |
| Lord | adds, edits or removes an epic on the page | that one epic under `## Epics`, saved through the page's API and journaled with the writer `Lord`; a save whose epic changed since he loaded the page is refused, and the page shows him the current epic; a save that would change the page outside `## Epics` is refused; a removal's journal row keeps the epic's title and notes |

Only the delivery write is checked by a command:
`throne check-where-i-stand --agent <alpha>` refuses, and with it the Alpha's
completion, until the campaign wrote its entry after its `REPORT.md`,
moved it out of `## In flight`, and started it with its links line. It also
refuses while another entry about the same work, last written before the
campaign's entry, is neither removed nor marked `Superseded by`; the
refusal names that entry's heading and the line to fix. The other writes
are duties.

## Edit tools and stale reads

No harness here refuses an edit to a file that changed since it was read.
What each one does, as of 2026-10-15:

- Claude Code: the Edit tool replaces one exact, unique piece of text, and
  needs a Read of the file in the session first. Measured on a scratch file
  changed by another process after the Read: the edit still applied, and the
  tool only added a note that the file had changed on disk.
- Codex: `apply_patch` applies hunks with context lines and fails when those
  lines no longer match the file. It keeps no record of reads. Read from the
  installed codex-cli 0.161.0, whose failures are "Failed to find context"
  and "Failed to find expected lines"; not run against a changed file.
- OpenCode: its edit tool replaces `oldString` and fails when that text is
  not found or is found more than once; before failing it retries ignoring
  typographic quote, dash and space variants and trailing whitespace. It
  keeps no record of reads. Read from its source; not installed here, not
  run.

So two things keep the page safe. The exact-text replacement limits an edit
to the text it is given. The checksum at `lock` proves the read is current:
the lock is refused unless the page still has the checksum `show` printed,
and while it is held no other agent can take it. An edit made without the
lock, or under a lock killed before it could journal, is caught by the next
`show`, `lock` or `note`, journaled with the writer `unknown`, and reported
to the Regent.

## Any harness can run this

Every step is a shell command or a file edit. Nothing here needs a tool that
only one harness has: "background run" means whatever your harness offers
for a command that keeps running while you answer, and stopping the lock
means that harness's own way to stop such a command.
