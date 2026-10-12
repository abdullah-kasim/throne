---
name: pr-address-feedback
description: 'This throne-only, STAGER-ONLY skill answers every review comment on a pull request by default, bots included, on GitHub or in Forgejo: it dumps every unresolved thread and conversation finding on the pull request and on the pull requests that were rolled into it, reads each against the code, shows the Lord which are sound and which are not, and files one queue row straight away that fixes the sound ones, replies on every thread and finding (the fixing commit, the line that disproves the claim, or a closing line), and resolves what is concluded. Invoked by /pr-address-feedback <pull request url> (aliases: /pr-review-feedback, /pr-feedback-address), or when the Lord says "see if the review comments make sense", "address the feedback on N", "fix and respond to the reviews", "we forgot to respond to the comments on N", or "answer the reviewers". Invoking it is the order to fix and reply; the Lord''s word is needed only to skip an item or overrule a verdict.'
version: 1.1.0
user-invocable: true
---

# Address the review feedback on a pull request

A review comment is a claim about the code. The job is to check the claim
against the code before anyone acts on it, fix what is right, answer what is
wrong with the line that shows why, and leave nothing unanswered. Reviewers
stop reviewing when their comments vanish into silence.

## 0. Find where the pull request lives

```bash
throne forge status <pull request url> --json
```

Read `stage`. `"github-only"`, `"merged-on-github"` or `"closed"` is a
GitHub pull request that is not worked on in Forgejo: steps 1 to 3 below
apply exactly as written. `"forgejo-only"` is a Forgejo pull request and
`"promoted"` is a GitHub one promoted from Forgejo (then `forgejo.url` names
its Forgejo twin): follow "On Forgejo" at the end instead of the `gh`
commands, and keep step 2 as written.

## 1. Dump every unresolved thread, including the rolled-in ones

```bash
node .claude/skills/pr-address-feedback/threads.mjs <pull request url>
node .claude/skills/pr-address-feedback/threads.mjs <pull request url> --all --json
```

It routes to `gh` or `ghe` by host, prints every unresolved review thread
AND the whole conversation tab (plain comments and the bodies of submitted
reviews) on the pull request, then does the same for every MERGED pull
request whose base was this one's head branch. Feedback does not only live
in line threads: automated reviewers post their findings as conversation
comments, and a reviewer's approval often carries its points in the review
body. A run that reads only the threads can report "nothing left to fix"
while an automated reviewer has repeated the same finding three times in
the conversation tab. For an automated reviewer
only its latest report is printed, since each one supersedes the last; read
it for findings marked "still present" or "fix here".

The rolled-in layers matter too, at every depth: the script follows every
merged or closed pull request whose base was this one's head branch, then
the ones based on THOSE heads, and so on, so a stack rolled up three layers
deep has every layer's comments on the page (Lord, 2026-09-24: "If it WAS a
stacked PR make sure to check comments from other PRs too"). Closed layers
count as well as merged ones: a layer closed after its code was rolled in
still holds unanswered comments. a stack that was rolled up with `/pr-merge`
carries its review threads on the closed layers, and those threads are still
open conversations with real people (the 2026-09-23 case: every comment on
the rolled layer was unanswered while the root showed "no unresolved
threads"). `--all` includes resolved threads; `--json` is for scripts.

Each thread prints its id, path and line, who opened it, how many comments
it holds and who spoke last, then every comment with its id. A thread whose
last word is the reviewer's is waiting on us; one whose last word is the
Lord's may still need a closing line and a resolution.

## 2. Read each comment against the code, then show the Lord

For every thread and every conversation finding (treat each finding in an
automated report as its own item, with the file and line it names), open
the file at the line on the branch the code now
lives on (after a roll-up, that is the root's branch, not the closed
layer's) and decide, with evidence:

- **Sound**: the claim holds and names a fix; say what the fix is in one
  sentence, and which existing function it extends (the `REUSE:` habit).
- **Not sound**: the claim does not hold; say which line shows it, so the
  reply can quote it.
- **Already answered**: the Lord or someone else replied and the matter is
  settled; it needs a closing line and a resolution, or, when it is still a
  live design conversation, a reply and it stays open.
- **The Lord's own**: a note he left for reviewers; never reply to it,
  never resolve it.

Show the Lord a table: number, author, one-line claim, verdict, the fix or
the counter-line. The table is shown, not put up for approval: invoking
this skill is the order to fix every sound item and reply on every item, so
file the row (step 3) straight away with the table in `RULINGS:`. The
Lord's word is needed only to skip an item or to overrule a verdict ("skip
that one", "that reviewer is right after all"); it goes into `RULINGS:`
verbatim, and a skipped item is recorded there as skipped. A word that
arrives after the row is filed reaches it through /amendment.

## 3. File one queue row

`/queue-objective` applies in full. The row targets the branch the code
lives on now (`--target-branch` and `--pr-branch` the same, `--base-commit`
from its tip) and carries, per thread: the thread id, the first comment id,
the path and line, the verdict, and the exact change. The Alpha then:

- makes one commit per fix with a test where the behaviour is testable;
- replies on every thread and every conversation finding the row does not
  skip, in one of three shapes: sound, the commit that fixes it; not sound,
  the line that shows the claim does not hold; already answered, a closing
  line;
- answers a conversation finding with one conversation comment
  (`<gh> pr comment <number> --body ...`) per finding;
  conversation comments cannot be resolved, so the reply is the closure;
- replies on each thread with `<gh> api repos/<owner>/<repo>/pulls/<number
  of the pull request that holds the thread>/comments -f body=... -F
  in_reply_to=<first comment id>`, two or three plain sentences;
- resolves each concluded thread with the `resolveReviewThread` GraphQL
  mutation and re-reads `isResolved`; a live design conversation gets its
  reply and is left open;
- never replies to or resolves the Lord's own notes;
- touches the pull request body only where a fix changed behaviour, editing
  from the live body, never from a local file;
- never merges; merging is `/pr-merge`'s job on the Lord's separate word;
- **loops on the automated reviewers until they have nothing left** (Lord,
  2026-09-24: "bot-driven reviews need to be looped until the bots come up
  with nothing else to address"). After every push, wait for each bot that
  reviews code (see "Which bots get a reply") and has reviewed this pull
  request before to post a report newer
  than the push: poll `threads.mjs --json` every 60 seconds, up to 20
  minutes per round. Read the new report. Every finding that is sound and
  addressable is fixed and answered in the same way as the first round,
  then push and wait again. Stop when the latest report from every bot has
  no finding the Alpha judges addressable (a finding judged not sound gets
  a reply in the bot's own reply form, such as `@<bot> rejected: <reason>`,
  and does not restart the loop), or after 5 rounds, or when a bot has not
  posted within 20 minutes of a push (record which in verify.md). Human
  reviewers are answered once per round; the loop does not wait on them.
  The queue row says this loop is on; it is the default for this skill.

### Which bots get a reply

A bot is an author whose login ends in `[bot]`, or the Copilot reviewer;
`threads.mjs` prints only each bot's latest report. Reply to every bot that
reviews code or asks for an action:

- an automated code reviewer's line threads and each finding in its
  conversation report (a style checker flags an unused import in the
  checkout form; a reviewer bot says the discount total can go negative);
- a bot asking for a checklist, a label, a confirmation or a sign-off (a
  release bot asks whether the recipe export needs a changelog entry; a
  licence bot asks the author to confirm a new font is free to ship).

Do not reply to informational bots: issue-tracker link-backs, deploy
previews, flaky-test and coverage reports, changelog notices. The one
exception is a bot reporting a failure this pull request caused, such as a
coverage bot showing the cart tests now fail to run: fix it, or reply with
why it is unrelated. Bot replies use the bot's own reply form where it has
one, such as `@<bot> rejected: <reason>` for a finding judged not sound.

The throne gh guard denies mutations by default. Invoking this skill is the
order to respond: it authorizes `--bypass` on replying and resolving, and
nothing else; re-read after every mutation, never trust a silent exit.

## A worked shape

A bakery ordering app's pull request has five unresolved threads: three
from an automated reviewer (a loop that sends the same order email twice, a
pickup date parsed without a time zone, a missing null check) and two from
a colleague (a button label that says "Pay" on a free sample, a query that
could be one instead of two). The conversation tab adds a release bot
asking whether this needs a changelog entry, a deploy-preview link and a
coverage report. A second pull request rolled into this one holds three
more threads: one with the Lord's reply as the last word and no
resolution, one live design conversation about gift-card rounding, and the
Lord's own note to reviewers.

The Stager shows the Lord the table and files the row at once; the Lord
says "skip the button label", and that goes into `RULINGS:` as skipped.
The row fixes the other three sound findings and replies on each with its
commit. The automated null check does not hold, because the caller two
lines up already returns early, so it gets `@<bot> rejected: <reason>`
quoting that line. The release bot gets its answer, yes, with the entry
added. The deploy preview and the coverage report get nothing, since
neither reports a failure. The thread with the Lord's last word gets a
closing line and is resolved; the gift-card thread gets a reply and stays
open; the Lord's own note is left alone. After the push the automated
reviewer reports again with nothing new, and the loop stops.

## On Forgejo

Feedback on a staged pull request is fixed and answered in Forgejo first,
where the Lord reads it (Lord, 2026-10-07: "if we have review comments on
github, those get lazily mirrored to forgejo and resolved in forgejo first
before being repromoted"). Nothing in this skill or its queue row writes to
GitHub; carrying the answers back is `/pr-promote`, on the Lord's word only.
Every command below takes the GitHub or the Forgejo URL and runs from the
local checkout of the repository.

**A GitHub pull request that is not staged yet.** When step 0 answers
`"forge": "github"` on a host that has Forgejo, and the Lord asked for the
feedback to be handled in Forgejo, stage it first:

```bash
throne forge stage <github pull request url>
```

It opens the Forgejo twin with the GitHub title, body and media, writes the
twin's metadata comment, mirrors the GitHub feedback once, and writes nothing
to GitHub. It refuses when the head branch is not fetched and names the
`git fetch origin <head>:<head>` to run. Then follow the steps below on the
printed `twinUrl` or the GitHub URL. Without that request from the Lord, a
GitHub pull request that was never staged stays on GitHub and steps 1 to 3
apply as written.

1. **Mirror.** Copy the GitHub feedback into the Forgejo twin:

   ```bash
   throne forge mirror-feedback <pull request url>
   ```

   It reads every unresolved review thread, conversation comment, review
   body and each bot's latest report with `threads.mjs`'s own reader, and
   posts each one into the twin once: an inline comment as a Forgejo review
   comment on the same file and line while that line is still in the diff,
   otherwise as a conversation comment naming the file and line. Each carries
   its author, its GitHub link, the original text and a hidden record of its
   GitHub id, so running it again adds nothing. A Forgejo pull request with
   no metadata comment answers that it has none linking a GitHub pull
   request; it has nothing to mirror, so go on to the dump.
2. **Dump.** `throne forge pr feedback <pull request url>` prints every
   Forgejo review comment, conversation comment and review body as JSON:
   `id`, `kind`, `author`, `place` (`path`, `line`, `onOldSide`, or `null`),
   `resolved`, `url`, `body`, `githubKey` (set on a mirrored item) and
   `answers` (set on an answer to another item). An item with `answers` is
   already a reply; the metadata comment holding the GitHub link is not
   feedback. Read the rest exactly as step 2 says.
3. **The queue row.** Step 3 applies with these changes for the Alpha:
   - pushes each fix with `throne forge push-branch --branch <head>`, never
     to `origin`;
   - replies on each item with `throne forge pr answer <pull request url>
     --comment <id> --body-file <file>`, adding `--resolve` when the item is
     concluded. A review comment is then resolved in Forgejo; a conversation
     comment records the resolution in the answer, so a later repromote
     resolves the GitHub thread it mirrors. Re-read with `pr feedback`;
   - runs no `gh` command, no `--bypass` and no `resolveReviewThread`.

**Forgejo gaps; say them plainly and do not work around them:**

- The automated-reviewer loop does not run: GitHub's bots see nothing until
  the Lord repromotes, and Forgejo has no review bots. The row says so.
- Rolled-in layers are not followed on Forgejo: `pr feedback` reads the
  given pull request only. A staged pull request's GitHub layers are still
  mirrored, because the mirror reads them with `threads.mjs`.
- Forgejo's API cannot resolve a review conversation, so `--resolve` signs
  in as the Forgejo admin with the password `install-forgejo.sh` stored and
  uses Forgejo's own resolve action. When that password file is missing,
  `--resolve` refuses; answer without it and tell the Lord.
