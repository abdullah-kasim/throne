---
name: pr-review
description: 'This throne-only skill reviews someone else''s pull request for the Lord and leaves the result as an UNSUBMITTED (pending) review on GitHub, line comments only, ready for him to read, edit, and submit himself. It reads the code, not the description; when the diff touches front-end code it also runs /frontend-critic against the running change and turns its findings into line comments. Invoked by /pr-review <pull request url>, or when the Lord says "review this PR", "review PR N for me", "leave a pending review", "draft a review", or "look over this PR". It never submits, approves, or requests changes: submitting is the Lord''s act.'
version: 1.0.0
user-invocable: true
---

# Review a pull request, leave it pending for the Lord

The output is a pending review on the pull request: line comments attached
to exact lines on the new side of the diff, no body, not submitted. Nobody
but the Lord sees it until he opens the pull request, reads each comment,
edits or deletes what he disagrees with, and presses Submit. So every
comment must be one he could send as his own: specific, checked, and
polite.

Who runs it: a Stager directly for a small pull request, or, on the Lord's
word, an Alpha from a queue row filed with `/queue-objective` (opus
sliceless is the usual shape; its effort follows the row). Either way the
review is created with his account, which is why it stays pending.

## 1. Read the pull request as it runs, not as it is described

```bash
node .claude/skills/pr-address-feedback/threads.mjs <url>
<gh> pr view <n> --repo <owner>/<repo> --json title,body,baseRefName,headRefName,headRefOid,files
<gh> pr diff <n> --repo <owner>/<repo>
```

`<gh>` is `gh` for github.com and `ghe` for the enterprise host (the
`pr-merge` and `pr-address-feedback` scripts route it for you). Fetch the
head into a throwaway worktree (`git -C <repo> worktree add --detach
~/tmp/review-<n> <head sha>`), never into the live checkout, and read the
changed files there so line numbers are exact.

Read the existing threads and conversation first: a point someone already
raised is not raised again; reply there instead only if you have something
new, and say so to the Lord rather than posting it.

Then follow the change the way a request would: entry point, what
authenticates it, what it changes, what reads it back. Run the tests that
cover the change, and run the project's own lint; a comment backed by a
failing command is worth three backed by reasoning.

## 2. Hunt, in this order, with these questions

Read the whole diff once for shape, then go looking. Each pass asks one
question of every changed function; most real findings come from passes 1
to 4, which is why they come first.

1. **Failure paths.** What does each call do when its dependency answers
   with an error, a timeout, an empty result, or a malformed one? A reply
   that is read as data when it is an error (a Redis `-ERR` line, an HTTP
   error body parsed as JSON, a `null` treated as "no rows") is the most
   common serious bug an automated reviewer finds and a human misses.
2. **Concurrency and repetition.** What happens if this runs twice at once,
   on two replicas, or twice in a row? Retries that re-send a used token,
   counters that count calls instead of outcomes, a "nothing removed" read
   that is really "someone else removed it first".
3. **Security boundaries.** Who can reach this, with what? Does every check
   refuse on failure rather than let the caller through? Is a path name
   doing the job of an actual control? Is a secret, token, or personal
   field logged, echoed, or put in a URL?
4. **Tests that would pass without the fix.** For each new or changed test,
   ask what it would do with the production change reverted; if you can,
   revert it in the throwaway worktree and run the test. A test that
   passes both ways is a finding (the 2026-09-23 case: a login test that
   still passed with the cookie removed, because it skipped the auth
   layer).
5. **Deploy and operations.** New environment variables and whether the
   service still starts without them; the order this must ship relative to
   the other side of a contract; what an existing user sees on the first
   request after deploy (sessions invalidated, caches cold, a migration
   half-applied); alerts and dashboards that still describe the old
   behaviour.
6. **Duplication.** A new function whose body repeats one already in the
   repository: grep the module for the verb (`git grep -n -E "func
   (sign|verify|retry)" -- <module>`) before claiming it, and name the
   existing function in the comment.
7. **Contracts and words.** A name, comment, doc, error message, or PR
   description that says something the code does not do.

Not worth a comment: style the linter owns, taste, restating what the code
does, praise, and anything you could not confirm.

## 3. Refute every finding before it becomes a comment

Every candidate gets a second pass whose only job is to prove it wrong:
read the callers, the caller's error handling, the config that gates it,
and the test that covers it. Keep it only when that pass fails to kill it,
and record how it survived: the command you ran, the input that breaks it,
or the line that shows it. A finding you could not reproduce and could not
disprove goes in the note to the Lord as "suspected", never in the review;
the Lord submits these under his own name.

Then rank what survived: bugs and security first, then blind tests,
deploy risks, duplication, words. Past about ten comments the review stops
being read: keep the ten that matter most and list the rest to the Lord.

Each comment: one finding, on the exact line (or `start_line`..`line` for a
range), what is wrong, the input or step that shows it, and the fix in one
sentence or a `suggestion` block the author can apply. Plain words, no
"nit:" or severity prefixes unless the Lord's own style uses them, no
questions that are really statements, and no review body at all.

## 4. Front-end changes: run /frontend-critic

When the diff touches markup, CSS, component rendering, or anything a
browser draws (file types such as `.css`, `.scss`, `.html`, `.tsx`, `.jsx`,
`.vue`, `.svelte`, or templates), run the `/frontend-critic` skill against
the change running locally at the pull request's head, at desktop and at
the phone viewport it names. Every defect it reports that the diff caused
becomes a line comment on the line that caused it, with the measurement
(for example "the list opens 30 px left of its button at 1440 px wide").
Screenshots stay under `~/tmp/review-<n>/`; they are never committed and
never uploaded without the Lord's word. A defect with no line to attach to
goes in the summary to the Lord instead.

## 5. Leave the review pending

Write the comments to `~/tmp/review-<n>.json` as an array of
`{ "path", "line", "body" }` (optionally `"start_line"`), paths relative to
the repository root, lines on the new side. Check the payload, then create
the review:

```bash
node .claude/skills/pr-review/pending-review.mjs <url> ~/tmp/review-<n>.json --dry-run
node .claude/skills/pr-review/pending-review.mjs <url> ~/tmp/review-<n>.json
```

The script pins the review to the head commit, omits the submit event (so
GitHub keeps it PENDING), passes the throne gh guard's `--bypass` only when
that guard is the `gh` on PATH, then reads the review back and fails unless
it is PENDING with every comment attached. GitHub allows one pending review
per person per pull request: if one exists already, the create call fails;
add to it with the pull request's review comments endpoint instead of
deleting it, and never delete the Lord's own pending comments.

The Lord's order to review authorizes creating the pending review and
nothing else: never submit it, never approve, never request changes, never
reply on other threads.

## 6. Tell the Lord

One short table: file:line, the finding in a sentence, how it was
confirmed (a command, a test, a measurement). Then the link to the pull
request's Files tab, where the pending review waits; the "suspected" items
that did not make the review, each with what would settle it; and anything
worth his attention that had no line to attach to. Remove the throwaway
worktree.

When he edits or deletes a comment before submitting, that is a ruling
about what he wants from a review: ask him whether it should become a line
in this skill, and write it here if he says yes.
