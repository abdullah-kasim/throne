---
name: pr-address-feedback
description: 'This throne-only, STAGER-ONLY skill answers every review comment on a pull request by default, bots included: it dumps every unresolved thread and conversation finding on the pull request and on the pull requests that were rolled into it, reads each against the code, shows the Lord which are sound and which are not, and files one queue row straight away that fixes the sound ones, replies on every thread and finding (the fixing commit, the line that disproves the claim, or a closing line), and resolves what is concluded. Invoked by /pr-address-feedback <pull request url> (aliases: /pr-review-feedback, /pr-feedback-address), or when the Lord says "see if the review comments make sense", "address the feedback on N", "fix and respond to the reviews", "we forgot to respond to the comments on N", or "answer the reviewers". Invoking it is the order to fix and reply; the Lord''s word is needed only to skip an item or overrule a verdict.'
version: 1.1.0
user-invocable: true
---

# Address the review feedback on a pull request

A review comment is a claim about the code. The job is to check the claim
against the code before anyone acts on it, fix what is right, answer what is
wrong with the line that shows why, and leave nothing unanswered. Reviewers
stop reviewing when their comments vanish into silence.

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
