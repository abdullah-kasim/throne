---
name: pr-review
description: 'This throne-only skill reviews a pull request for the Lord as a principal engineer who will own the code in production, and posts the result as a review of line comments on the pull request''s Forgejo twin, plus one conversation comment holding every finding ready for him to copy into GitHub. GitHub gets a pending review only when he says "/pr-promote the review", "promote the review" or "send the review to GitHub". It reads the code, not the description, and runs /frontend-critic on front-end changes. Invoked by /pr-review <pull request url>, or when the Lord says "review this PR", "review PR N for me", "leave a pending review", "draft a review", or "look over this PR". Its self-review mode, on "/pr-review my own PR ... and fix it", "self-review" or "review and fix my PR", reviews his own pull request, fixes each finding in its own commit, pushes the fixes to Forgejo only, and posts nothing. It never submits, approves, or requests changes: submitting is the Lord''s act.'
version: 1.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension pr-review` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Review a pull request on Forgejo first

## The reviewer

Review as if you will own this code in production and own its security.
Assume the change is broken until the code proves otherwise. Hunt failure
paths, trust boundaries and data exposure first, and never pad the review
with style or praise. Security is a lens you always apply, not your whole
job: a crash on an empty reply matters as much as a leaked token.

This is a reviewing stance only. The reviewer never pages, notifies,
mentions, messages or contacts anyone, and the stance changes nothing
about what this skill may write.

## What this skill writes

- Normal mode: one review of line comments on the pull request's Forgejo
  twin, and one conversation comment there that holds the same findings
  ready to copy into GitHub.
- Self-review mode: fix commits, pushed to Forgejo only, and one hidden
  record of the reviewed head in the Forgejo pull request's body, which
  shows nothing to a reader.
- On "/pr-promote the review": one pending review on GitHub.

Nothing else is posted, sent or announced anywhere: no replies on other
threads, no @-mentions, no review requests, no chat messages, no
notifications. Nothing is ever submitted, approved, or marked as
requesting changes.

Every line comment must be one the Lord could send as his own: specific,
checked, and polite. On Forgejo he reads each one, edits or deletes what
he disagrees with, and only then promotes what is left to GitHub.

Who runs it: a Stager directly for a small pull request, or, on the Lord's
word, an Alpha from a queue row filed with `/queue-objective` (opus
sliceless is the usual shape; its effort follows the row).

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

Read `publishTo` from `throne forge status <url> --json` first. `github` (a
github.com or enterprise url, staged in Forgejo or not) is still read
exactly as above, with `threads.mjs` and `<gh>`. `forgejo` (a url of this
host's Forgejo) is read through the forge seam instead:
`throne forge pr view <url>` and `throne forge pr diff <url>`, with the head
fetched from the checkout's `forgejo` remote. The seam reads no review
threads, so `threads.mjs` is not run, and the Lord is told the review was
written without the existing conversation. Either way the review is posted
on Forgejo in step 5.

Read the existing threads and conversation first: a point someone already
raised is not raised again; reply there instead only if you have something
new, and say so to the Lord rather than posting it. The "Existing
reviewers' findings" list in step 6 tells him where this review stands on
each of those points, so a skipped one reads as a choice, not a miss.

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

## 5. Post the review on Forgejo

Write the comments to `~/tmp/review-<n>.json` as an array of
`{ "path", "line", "body" }` (optionally `"start_line"`), paths relative to
the repository root, lines on the new side.

A GitHub pull request with no Forgejo twin (`throne forge status <url>
--json` shows none) is staged first:

```bash
throne forge stage <github url>
```

Check the payload, then post the review:

```bash
node .claude/skills/pr-review/pending-review.mjs <url> ~/tmp/review-<n>.json --dry-run
node .claude/skills/pr-review/pending-review.mjs <url> ~/tmp/review-<n>.json
```

The url may be the Forgejo pull request or its staged GitHub twin; either
way the script hands the file to `throne forge pr review`, which posts one
Forgejo review holding every line comment, never submitted for approval or
changes, and writes the one copy-paste comment. That comment lists each
finding as a `path:line` heading and its body, so the Lord can paste them
into GitHub by hand. A second review run rewrites the same comment in place
instead of adding another. The copy-paste comment is never promoted to
GitHub. The script prints the review url and the comment url; GitHub is not
touched.

## 6. Tell the Lord

One short table: file:line, the finding in a sentence, how it was
confirmed (a command, a test, a measurement). Then the Forgejo review url
and the copy-paste comment url, both printed in step 5; the "suspected" items
that did not make the review, each with what would settle it; and anything
worth his attention that had no line to attach to. Remove the throwaway
worktree.

**Existing reviewers' findings** (required). One line per finding already
on the pull request, built from the `threads.mjs` output read in step 1,
with no second fetch: line threads, review bodies and conversation
comments, from people and bots alike. A review body or bot report holding
three findings gives three lines. Each line gives who raised it;
`file:line`, or "review body" for a finding with no line (a conversation
comment included); the finding in one sentence; and one verdict:

- `same finding`: this review reached it on its own.
- `agree`: checked and it holds; not in the review because step 1 does
  not repeat a point already raised.
- `disagree: <one-clause reason>`: checked and it does not hold.
- `not assessed`: not checked.

An "agree" or "disagree" carries the same burden as a comment: it must
survive step 3's refute pass, and an opinion that did not go through it is
"not assessed". The list is for the Lord only; none of it is posted to the
pull request. The report message to the supervisor (or the Lord) carries
the counts, for example "Existing findings: 5 (same 1, agree 2, disagree
1, not assessed 1)".

When he edits or deletes a comment before submitting, that is a ruling
about what he wants from a review: ask him whether it should become a line
in this skill, and write it here if he says yes.

## Promote the review

Only on "/pr-promote the review", "promote the review" or "send the review
to GitHub". Plain "/pr-promote <pr>" never carries the review; see
`/pr-promote` for how the pull request itself is promoted.

Read the review's line comments back from Forgejo as the Lord left them
(his edits kept, his deletions dropped), then create the GitHub pending
review from them, dry run first:

```bash
throne forge pr review-findings <forgejo url> --out ~/tmp/review-<n>-github.json
node .claude/skills/pr-review/pending-review.mjs <github url> ~/tmp/review-<n>-github.json --to-github --dry-run
node .claude/skills/pr-review/pending-review.mjs <github url> ~/tmp/review-<n>-github.json --to-github
```

The script pins the review to the head commit, omits the submit event (so
GitHub keeps it PENDING), passes the throne gh guard's `--bypass` only when
that guard is the `gh` on PATH, then reads the review back and fails unless
it is PENDING with every comment attached. GitHub allows one pending review
per person per pull request: if one exists already, the create call fails;
add to it instead of deleting it (below), and never delete the Lord's own
pending comments. The copy-paste comment is never promoted.

### Changing a pending review: GraphQL, not REST

GitHub's REST review-comment routes cannot see a pending comment:
`PATCH /repos/<owner>/<repo>/pulls/comments/<id>` returns 404 for one (seen
2026-10-05). Add, edit or delete pending comments through
GraphQL instead, on both github.com and the enterprise host.

1. Get the node ids. The review's comes from
   `<gh> api repos/<owner>/<repo>/pulls/<n>/reviews/<review id> --jq .node_id`,
   and each comment's from
   `<gh> api repos/<owner>/<repo>/pulls/<n>/reviews/<review id>/comments --jq '.[] | [.node_id, .path, .line] | @tsv'`.
2. Run the one mutation you need with `<gh> api graphql`, passing `--bypass`
   only when the throne gh guard is the `gh` on PATH (the same check
   `pending-review.mjs` makes):

   ```bash
   # add a comment to the pending review
   <gh> api graphql -f review=<review node id> -f path=<path> -F line=<line> -f body=<text> -f query='
     mutation($review: ID!, $path: String!, $line: Int!, $body: String!) {
       addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, line: $line, side: RIGHT, body: $body}) { thread { id } }
     }'
   # edit one of your own pending comments
   <gh> api graphql -f id=<comment node id> -f body=<text> -f query='
     mutation($id: ID!, $body: String!) {
       updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $body}) { pullRequestReviewComment { id } }
     }'
   # delete one of your own pending comments
   <gh> api graphql -f id=<comment node id> -f query='
     mutation($id: ID!) { deletePullRequestReviewComment(input: {id: $id}) { pullRequestReview { id } } }'
   ```

3. Read the review back afterwards, as the script does, and confirm it is
   still PENDING with the comments you expect.

Only comments this run created may be edited or deleted. The Lord's own
pending comments are never touched.

## Self-review mode

Triggers: "/pr-review my own PR ... and fix it", "self-review", "review and
fix my PR", and a self-review step in `/pr-promote` or `/pr-merge`.

1. **Refuse on someone else's pull request.** Self-review is for the
   Lord's own pull requests only; on any other, stop and tell him so. Read
   the author: for a GitHub pull request, or a Forgejo pull request staged
   from one, the GitHub author decides
   (`<gh> pr view <n> --repo <owner>/<repo> --json author --jq .author.login`
   against `<gh> api user --jq .login`). A Forgejo pull request with no
   GitHub twin was opened by this throne and is his.
2. **Stage first** when a GitHub pull request has no Forgejo twin:
   `throne forge stage <github url>`.
3. **Review.** Run steps 1 to 4 in full, as the same reviewer, with the
   same hunt and refute passes. Check out the head branch itself, not a
   detached head (`git -C <repo> worktree add ~/tmp/review-<n> <head
   branch>`), so the fixes land on it.
4. **Fix every finding that survived refutation, one commit per finding.**
   Before each commit, check the repository's identity with
   `git var GIT_COMMITTER_IDENT`. A finding whose fix turns out to be wrong
   when attempted is dropped, with why. Then run the project's tests and
   lint, and fix what they show.
5. **Push to Forgejo only:**
   `throne forge push-branch --branch <head branch> --repo <repo>`. GitHub
   gets the fixes on the next `/pr-promote`.
6. **Record the reviewed head**, the final head after the fixes:
   `throne forge pr self-reviewed <url> --head <sha>`. It writes one hidden
   record, `<!-- self-review: <sha> -->`, into the Forgejo pull request's
   body, replacing an earlier one, and leaves the rest of the body as it
   was. It posts no comment and no review, and a reader sees nothing.
7. **Post nothing.** No Forgejo review, no copy-paste comment, no GitHub
   review, no replies.
8. **Report** each finding with its fixing commit, each finding rejected on
   a fix attempt with why, and the "suspected" list from step 3. When run as
   a step of `/pr-promote` or `/pr-merge`, the report goes into that row's
   REPORT.md.
