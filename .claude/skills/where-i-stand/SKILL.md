---
name: where-i-stand
description: 'This throne-only skill points the Lord at the page of what he is working on: tabs, sections and rows in the throne database that agents write through commands, served by the throne backend on the tailnet below a table of his pull requests, where the Lord adds, edits and removes his epics and reads everything else. Its answer in the terminal is the page''s link and nothing else; the page, the table and what changed sit in the browser. It then reads the forges, the queue and the live agents in the background, puts the differences on the page, corrects the page entry by entry, and checks that the tailnet page is up. Use when the Lord asks "where do I stand", "what am I working on", "what needs me", "how are my PRs going", "show me the page", or invokes /where-i-stand. It also holds the writing rules every agent follows when it edits that page.'
version: 2.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension where-i-stand` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Where I stand

The Lord reads one page to see what he is working on while many agents are
busy. It lives as tabs, sections and rows in the throne database,
`where-i-stand.sqlite3` under the throne data home, owned by throne-backend. Agents write it as they file, launch, block and deliver work, so it is
already there when he asks. The Lord's own page edits are for epics only: he
adds, edits and removes them on the page's Epics tab, and every other tab is
read-only. This skill points him at it first and corrects it second.

Every change is a command, and every command is journaled with you as the
writer. Run `throne where-i-stand list` before any add: it prints every tab
and section with its id, archived ones marked, and a listing token. An add
names a section by id and passes that token; a token from before the
structure last changed is refused with the current listing. Nothing is ever
removed: `archive` hides a row or a section in a spoiler at the foot of its
section, `restore` brings it back, and a row archived for six months is
purged. There is no file to edit; `show` prints the page as Markdown to read,
never to edit.

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
it alone.

These are today's tabs and sections, and they are kept as they are. An agent
may add a tab with `add-tab` or a section with `add-section`, each with the
current listing token; one whose name matches a sibling's, ignoring case and
surrounding spaces, is refused, or revives that sibling when it is archived.

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

`show` prints the page as Markdown generated from the database, every row
with its exact written and changed dates. It is read-only: nothing you change
in the copy reaches the page. This copy is for you, not for the Lord: step 3
compares against it.

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
what step 2 found with the page from step 1, and put every correction onto the
page through step 4: a state the page has wrong, work the page
does not list, work that finished since the page last said otherwise.

When step 2 finishes, tell the Lord nothing more unless something now needs
him. Then write at most one line naming it, with the link again.

### 4. Correct the page, one entry at a time

Every correction is a command; there is no file to edit. List first:

```bash
throne where-i-stand list
```

It prints every tab and section with its short id, archived ones marked,
each with its exact dates, and a `listing token`. Keep the token: every add
needs it, and when the structure changed since your `list` the add is
refused with the current listing printed. Then list again and use the new
token.

To add, move or replace one entry, run `put`:

```bash
throne where-i-stand put --code <objective code or repo#number> --section-id <id from list> --listing-token <token from list> --text-file <file>
```

The file holds the entry's lines under its `### <code>` heading, starting
with the entry form; `--text "<entry body>"` takes them inline instead.
`put` writes the row, archives every other current row with the same code,
journals you as the writer, and refuses an entry that does not start with
the entry form, naming the missing line. Adding to an archived section
revives the section, and `put` says so. A section name is never accepted
in place of an id.

To take an entry off the page, archive it; nothing is ever deleted by hand:

```bash
throne where-i-stand put --code <code> --remove
throne where-i-stand archive <row or section id>
throne where-i-stand restore <row or section id>
```

`put --remove` archives the entry with that code. `archive` takes a row's or
a section's id from `list` or `show`; a section is archived with everything
in it. `restore` undoes either. A row archived for more than six months is
purged on the backend's own tick; `throne where-i-stand purge --dry-run`
lists what would go, and nobody needs to run `purge` by hand.

Go through what step 2 found and run one command per correction:

- fix every state step 2 showed to be wrong;
- add what was missing, each as its own entry;
- move finished work to the section it now belongs under;
- archive an entry one day after its work merged or was abandoned;
- write every entry you add or correct in the entry form "Writing rules
  for the page" gives;
- archive or mark superseded every other entry about the same work as an
  entry you corrected, as "Writing rules for the page" says.

`## Just happened` keeps its newest 15 notes by itself. This correction pass
skips `## Epics`: the forges and the queue know nothing about it, so nothing
they say corrects an epic.

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
curl -s "$tailnet_address/throne/api/where-i-stand/store/page" | python3 -c 'import json,sys; json.load(sys.stdin)["tabs"]'
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
- The page reads the database through throne-backend on every load, so it
  always shows the live rows. Nothing is copied.
- When the data file is missing, run the reader once with `--refresh` (step
  2), which writes it.

The Lord archives, restores and edits epics on the page through the same
store, journaled with the writer `Lord`. An agent never writes through the
page's API.

## Writing rules for the page

These bind every agent that edits the page, whichever step or duty brought
it there.

- `list` before any add, and add by section id with its listing token (step
  4). Every change is one command; there is no file to edit.
- Archive, never remove. `put --remove` and `archive` hide a row where
  `restore` can bring it back.
- `## Delivered, not on GitHub` trims itself on every write: it keeps its
  newest 20 entries and every entry younger than 3 days, and archives the
  rest. Never trim it by hand.
- Plain words. The Lord reads this between other things; write what a person
  outside the work would understand.
- No agent adds, edits, closes or removes an epic unless the Lord says so in
  words. A Stager he tells to add one writes it into `## Epics` with `put`,
  like any entry. The entry rules below are for work entries; an epic holds only
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
  `throne check-where-i-stand` reports every group of current entries about
  the same work, a `## Needs you` question beside its work's own entry
  excepted.
- A link for every pull request. Never a bare number.
- Say what is not verified. An entry that names only what passed reads as
  finished work.
- Never copy a report into it. The page says where the work stands in a few
  lines and links to the rest.
- End each entry with a line naming who wrote it and when.
- Never start a line inside an entry with `## `. `show` prints sections as
  second-level headings, so such a line would read as a section of its own.
  Use `####` or bold text when an entry needs a label.
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
| Lord | adds, edits or removes an epic on the page | that one epic under `## Epics`, saved through the page and journaled with the writer `Lord`; a save whose epic changed since he loaded the page is refused, and the page shows him the current epic; a removal archives the epic, so he can restore it |

Only the delivery write is checked by a command:
`throne check-where-i-stand --agent <alpha>` refuses, and with it the Alpha's
completion, until the campaign wrote its entry after its `REPORT.md`,
moved it out of `## In flight`, and started it with its links line. It also
refuses while another entry about the same work, last written before the
campaign's entry, is neither removed nor marked `Superseded by`; the
refusal names that entry's heading and the line to fix. The other writes
are duties.

## Any harness can run this

Every step is a shell command. Nothing here needs a tool that only one
harness has: "background run" means whatever your harness offers for a
command that keeps running while you answer.
