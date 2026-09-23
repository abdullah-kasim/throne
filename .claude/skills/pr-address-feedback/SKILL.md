---
name: pr-address-feedback
description: 'This throne-only, STAGER-ONLY skill answers the review comments on a pull request: it dumps every unresolved thread on the pull request and on the pull requests that were rolled into it, reads each against the code, tells the Lord which comments are sound and which are not, and on his word files one queue row that fixes the sound ones, replies on every thread naming the commit, and resolves what is concluded. Invoked by /pr-address-feedback <pull request url>, or when the Lord says "see if the review comments make sense", "address the feedback on N", "fix and respond to the reviews", "we forgot to respond to the comments on N", or "answer the reviewers". Only the Lord orders the fixes and the replies.'
version: 1.0.0
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

The rolled-in layers matter too: a stack that was rolled up with `/pr-merge`
carries its review threads on the closed layers, and those threads are still
open conversations with real people (the 2026-09-23 case: every comment on
the rolled layer was unanswered while the root showed "no unresolved
threads"). `--all` includes resolved threads; `--json` is for scripts.

Each thread prints its id, path and line, who opened it, how many comments
it holds and who spoke last, then every comment with its id. A thread whose
last word is the reviewer's is waiting on us; one whose last word is the
Lord's may still need a closing line and a resolution.

## 2. Read each comment against the code, then tell the Lord

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
  settled; it needs a closing line and a resolution, or it stays open as a
  live conversation.
- **The Lord's own**: a note he left for reviewers; never reply to it,
  never resolve it.

Show the Lord a table: number, author, one-line claim, verdict, the fix or
the counter-line. He decides; his word ("fix and respond", "skip that one",
"that reviewer is wrong") goes into `RULINGS:` verbatim.

## 3. File one queue row

`/queue-objective` applies in full. The row targets the branch the code
lives on now (`--target-branch` and `--pr-branch` the same, `--base-commit`
from its tip) and carries, per thread: the thread id, the first comment id,
the path and line, the verdict, and the exact change. The Alpha then:

- makes one commit per fix with a test where the behaviour is testable;
- answers a conversation finding with one conversation comment
  (`<gh> pr comment <number> --body ...`) naming the commit per finding;
  conversation comments cannot be resolved, so the reply is the closure;
- replies on each thread with `<gh> api repos/<owner>/<repo>/pulls/<number
  of the pull request that holds the thread>/comments -f body=... -F
  in_reply_to=<first comment id>`, two or three plain sentences naming the
  commit, or the line that shows the claim does not hold;
- resolves each concluded thread with the `resolveReviewThread` GraphQL
  mutation and re-reads `isResolved`; leaves open the threads the row marks
  as live conversations;
- touches the pull request body only where a fix changed behaviour, editing
  from the live body, never from a local file;
- never merges; merging is `/pr-merge`'s job on the Lord's separate word.

The throne gh guard denies mutations by default. The Lord's order to
respond authorizes `--bypass` on replying and resolving, and nothing else;
re-read after every mutation, never trust a silent exit.

## A worked shape

A pull request with five unresolved threads: three from an automated
reviewer (a loop that sends the same email twice, a date parsed without a
time zone, a missing null check) and two from a colleague (a button label
that says the wrong thing, a query that could be one instead of two). Four
are sound; the automated null check does not hold, because the caller two
lines up already returns early, and the reply quotes that line. A second
pull request rolled into this one holds three more threads, one with the
Lord's reply as the last word and no resolution: it gets a closing line,
and a thread that is still a live design conversation stays open.
