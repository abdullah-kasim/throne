---
name: pr-merge
description: 'This throne-only, STAGER-ONLY skill gets a stack of pull requests ready for merge the way the Lord prefers, and lands it only on his explicit order to merge: identify the whole stack from any one pull request in it, roll every upper pull request into the root, bring it up to date, self-review it with /pr-review unless an earlier self-review already covers its head, prove the human scenario the Lord names on the rolled branch, and repromote it, leaving the root open and ready for merge. Only when his words explicitly order a merge ("merge it", "squash and merge", "land it") does the row then squash-merge the root on GitHub so the feature lands as one revertable commit, after answering every automated reviewer's finding on the final head; a person's comment posted during the run stops the merge. Forgejo never merges a pull request itself: a pull request staged there merges on GitHub, and after an actual merge its Forgejo pull request is closed with a comment saying so. In a repository whose git config sets throne.forge.landsOnMain to true there is no GitHub pull request at all: the /pr-merge order is itself the order to merge, and the Forgejo pull request lands on main as one signed squash commit. Invoked by /pr-merge <pull request url>, or when the Lord says "roll up this stack", "merge this stack", "land these PRs", "roll all PRs stacked on N into it", or "squash and merge N once scenario M passes". It asks the Lord two things (which pull request, the criteria that allow the merge), never whether it may merge, and then files one queue row; only the Lord orders a merge.'
version: 1.3.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension pr-merge` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Land a stack of pull requests by rolling it up

A stack exists for review: each layer is small enough to read. It lands as
one commit: a feature the team later does a complete about-face on is
reverted once, not three times (Lord, 2026-09-23: "We prefer stacking, and
we prefer rolling up before merging for easy rollbacks. I don't want to
revert 3 commits ... in case where we did a complete 180 on a feature and
want all the code annihilated"). Rolling up is therefore the standing way to
land a stack; `/pr-split` describes how the stack is cut, this skill how it
lands.

## 1. Identify the stack from any pull request in it

First check whether the repository lands on main:
`git -C <repo> config --type=bool --get throne.forge.landsOnMain`. When it
prints `true`, its pull requests live only in Forgejo and the script below
stops on every one of them; follow "### When the repository lands on main"
instead, which replaces this step and every GitHub step after it.

```bash
node .claude/skills/pr-merge/stack.mjs <pull request url>
node .claude/skills/pr-merge/stack.mjs <pull request url> --json
```

Give it any pull request, top, middle or bottom. It resolves the host to
`gh` (github.com) or `ghe` (the enterprise host), follows `base` upward until
it reaches the repository's default branch to find the root, then walks
downward through every open pull request based on a branch in the stack.
It prints one line per pull request with head, base, draft state, review
decision, mergeability and commit count, then the roll-up order. A pull
request whose base branch has no open pull request and is not the default
branch is a broken stack; the script says so and stops.

The script reads `mergeTarget` from `throne forge status <url> --json`: the
GitHub pull request a merge of it lands on. A github.com or enterprise url
is that pull request itself and takes the `gh`/`ghe` route above. A url of
this host's Forgejo whose pull request was promoted resolves to its GitHub
twin, and the whole stack is read on GitHub. A Forgejo pull request with no
metadata comment has a `null` `mergeTarget`, and the script stops with its
`mergeTargetRefusal`: "<url> is not on GitHub yet: it has no metadata
comment linking a GitHub pull request (it was never staged or promoted),
and nothing is merged in Forgejo. It must be promoted first with
/pr-promote on the Lord's word." Stop there, file nothing, and tell the
Lord exactly that. Run the script from the local checkout of the
repository, because a staged pull request is matched to its Forgejo twin
through the checkout's `forgejo` remote.

When the root is staged in Forgejo, the script prints one more line,
`root #<n> is staged in Forgejo as <forgejo url>; after the merge, close
it: throne forge close-merged-twin <root url>`, and `--json` carries the
Forgejo url as `forgejoTwin`. Put that close step into the row (below); it
runs only after an actual merge.

Read the output for a layer whose review decision is not `APPROVED`: the
Lord decides whether that blocks the merge or authorizes merging without
review; branch protection may decide for him. A root that is `CONFLICTING`
against the default branch is not a question for him: the row's **Update**
step merges the default branch in and resolves it.

## 2. Ask the Lord two things, and only these

Every invocation records the Lord's answers under `RULINGS:` in his words:

1. **Which pull request** — the url he gave, and the root the script found,
   so he confirms the stack is the one he means.
2. **What is the criteria that allows the merge?** — usually "Scenario N of
   pull request M passes on the rolled branch", sometimes "tests and lint
   only", sometimes several scenarios. The criteria is what the campaign
   proves and what the merge waits on; write it verbatim. When his order
   names no criteria, do not ask: the criteria is CI green on the final
   head plus the root PR body's own Testing scenarios, run on the updated
   head, recorded under `RULINGS:` as the default, with his words quoted.
   A root pull request with no `## Testing` section defaults to CI green
   only, and `RULINGS:` says so.

Whether the row merges is not asked; it has a stated default. Without an
explicit order to merge ("merge it", "squash and merge", "land it"), the row
gets the pull request ready (roll up, update, prove, answer the automated
reviews, repromote) and does not merge; the root stays open, ready for merge. The Stager does not ask whether
it may merge. With an explicit order to merge, quoted under `RULINGS:`, the
row does both: every ready step, **Answer** among them, then the **Merge**
step.

When the Lord already said both in the order that invoked this skill
("roll everything on N into it, make sure scenario 4 of M works, if it works
squash and merge"), do not ask again; quote him.

## 3. File one queue row for the roll-up

`/queue-objective` applies in full (five markers, `REUSE:` naming the code a
fix would touch, lint, launch facts). The row targets the ROOT pull
request's branch with `--target-branch` and `--pr-branch` both set to it and
`--base-commit` from its tip. Opus sliceless when the Lord says so; his
words, not the row's size, decide that.

The body carries this shape, filled in from the script's output:

- **Roll**: for each upper pull request in roll-up order (nearest layer
  first), `git merge --no-ff <its head>` into the root branch; never rebase,
  never force-push; a scratch-worktree dry merge before filing says whether
  it is clean. Build, vet, test and lint the rolled branch; push. Close each
  rolled pull request with one comment naming the merge commit. Move the
  scenarios that describe the rolled code from the closed bodies into the
  root's Testing section, editing from the live body, never from a local
  file.
- **Update**: after the roll-up, `git merge origin/<default>` into the root
  branch, and again right before the merge whenever the default branch
  moved; never rebase, never force-push. The conflict check is the
  `mergeable` column `stack.mjs` already prints: `CONFLICTING` means the
  merge has conflicts to resolve. Resolve conflicts keeping both sides'
  intent; build, test, lint, push. Wait for CI on the new head with a
  Monitor until-loop, never chained sleeps. Fix a failing check in its own
  commit and wait again. A moved default branch, a conflict, or a red check
  is work to do, never a reason to stop and ask.
- **Self-review**: after **Roll** and **Update**, before **Prove**, read
  `throne forge status <root url> --json` and its `selfReview`. When
  `selfReview.coversHead` is `true`, an earlier self-review already covered
  this code, whichever row or agent ran it, because the record lives hidden
  in the Forgejo pull request's body: skip this step, and REPORT.md names that earlier
  self-review by its recorded head (`selfReview.reviewedHead`). Otherwise
  run /pr-review's "Self-review mode" on the current head (on a root the
  Lord did not author it refuses, and REPORT.md says so); it records the
  head it reviewed, so a later repromote in this row on an unchanged head
  does not repeat it. A fix that touches files the pull request changes
  re-runs the proof as **Prove** says. It posts nothing on either forge,
  and it runs beside any code review an operator extension of this skill
  adds, not instead of it. REPORT.md lists each finding with its fixing
  commit or the reason it was rejected.
- **Prove**: run the criteria (the Lord's answer to the second question)
  exactly as the named pull request's body states it, every step, with the
  browser steps through the `agent-browser` skill and one screenshot per
  Expect, logs and screenshots under the Alpha's data directory (never
  committed; media commits need the Lord's explicit approval). Re-run the
  criteria on the new head when the update or a fix touched files the PR
  changes; otherwise the last proof stands.
- **Answer**: runs on every row, with or without a merge order, after
  **Prove** and before **Ready**, so the repromote and the ready state carry
  its fixes and answers (Lord, 2026-10-20: a /pr-merge resolves every
  automated review finding that makes sense before it repromotes or calls
  the root ready, merge order or not). On a merge order it opens with the
  person check: a
  review, review comment or conversation comment on the root by a person,
  created after the row launched, stops the merge (**Stop**). A person is
  any account GitHub does not report as automated, the operator's own
  account included. The row's own posts never count; they are matched by the
  comment ids the row recorded when posting them, not by author. So from its
  first step the row keeps its launch time and the id of every comment it
  posts in the Alpha's data directory. The window is the whole run, from the
  row launching until the merge command runs: the check runs again
  immediately before the merge command in **Merge**, and that last check
  closes the window, so a post that lands while CI or a reviewer is being
  waited on still stops the merge. A person's comment from before the launch
  does not stop the merge; it is only listed. Then read every review, review
  comment and conversation comment on the root
  (`<gh> api repos/<o>/<r>/issues/<n>/comments`,
  `<gh> api repos/<o>/<r>/pulls/<n>/comments`,
  `<gh> api repos/<o>/<r>/pulls/<n>/reviews`) and keep only those by
  automated reviewers, the accounts GitHub reports with `user.type == "Bot"`
  or a login ending in `[bot]`, that are about the head being merged or were
  posted after it was pushed. A person's review or comment is never answered
  or acted on by this step. An automated reviewer known to run on every
  push, because it reviewed an earlier push of this pull request or an
  operator's private extension of this skill names it, that has not yet
  reviewed the final head is waited for with a Monitor until-loop, as
  **Update** waits for CI, bounded at 30 minutes by default; if it never
  arrives, REPORT.md says so. Each automated finding is then judged against
  the code and the evidence, and either fixed or answered. A finding from an
  earlier review of an older head counts too, unless a later review lists it
  as resolved. A fix goes in its own commit through **Update** and **Fail**,
  exactly as a red check does, and the reviews are read again for the new
  head. An answer is a `pr comment` on the root that quotes or links the
  finding and, when the finding is rejected, carries the evidence: which
  test, which engines, what was observed. When the reviewer documents its
  own reply form, the answer uses that form; an operator's private extension
  of this skill may supply those forms. The Lord's /pr-merge order, with or
  without a merge in it, authorizes `--bypass` on `pr comment` on the root
  for these answers, and nothing else. Never merge over an automated finding
  that has neither a fix nor an answer, and never end a row without a merge
  order while one remains. REPORT.md carries a table of
  every automated finding on the final head with its fate (fixed: the
  commit; answered: the comment URL), and lists people's comments on the
  final head with their URLs, unanswered.
- **Ready**: after **Answer**, when the root has a Forgejo twin, repromote it
  with `/pr-promote` so both sides carry the final state; a root with no
  Forgejo twin skips this. The repromote checks the GitHub body it wrote for
  image and video links that point at the Forgejo host, which do not load on
  GitHub, and refuses while one remains. A refusal means the body was copied
  and the root is not ready: run the one repair command the refusal names,
  repeat the repromote, and go on only when it succeeds and
  `throne forge check-media-links <root url>` exits 0. Once Prove has
  passed, the repromote has succeeded, that check exits 0 and CI is green on
  the final head, and only then, a draft root leaves draft on both forges,
  so the next repromote does not disagree. Read
  `<gh> pr view <root> --json isDraft`; when it is a draft, run
  `<gh> --bypass pr ready <root>`, with `--bypass` right after the program
  name because the throne gh guard reads it only there, then read it back
  with the same `pr view` and confirm `isDraft` is false. That is the one
  GitHub write this step makes, on the root only, and the Lord's /pr-merge
  order authorizes it with or without a merge order. When the root has a
  Forgejo twin, read it with `throne forge pr view <twin url>`; a Forgejo
  draft is a title that starts with `WIP: `, and the view reports it as
  `isDraft` and prints the title without that prefix. When it is a draft,
  set that printed title, its `[GH-<n>]` marker and the rest kept exactly,
  with `throne forge pr edit <twin url> --title "<title>"`, then read it
  back with the same `pr view` and confirm `isDraft` is false and the
  marker is still there. A repromote copies the draft state from Forgejo
  only when it first opens the GitHub pull request. REPORT.md records
  "moved out of draft" with the forges it changed, or says the root was
  already ready. A merge-ordered row passes through this step too, on its
  way to **Merge**. Without an explicit merge order in the
  RULINGS, the row ends here: the root stays open, ready for merge and out
  of draft, and REPORT.md records "ready for merge" plus the head sha.
- **Merge**: runs only when the RULINGS quote an explicit merge order; it
  comes after every ready step above and after **Answer**. Immediately
  before the merge command, run the person check from **Answer** again; a
  hit is a **Stop**. Every Expect observed and CI green on the head →
  `<gh> pr merge <root> --squash --delete-branch=false`, then read the pull
  request back and confirm `MERGED` and the squash commit on the default
  branch. The merge method is always squash and is never asked (Lord,
  2026-10-06: "we always merge with squash merge FWIW"). When the Lord's
  words authorize merging without review, recorded under `RULINGS:`, the
  command is `<gh> pr merge <root> --squash --admin --delete-branch=false`,
  and `--admin` covers ONLY the missing-approval requirement. A failing
  required check is never bypassed: it is made to pass through **Update**
  and **Fail**. The throne gh guard denies mutations by default; the Lord's
  /pr-merge order, with or without a merge order, authorizes `--bypass` on
  `pr ready` on the root only (in **Ready**), and his merge order
  authorizes `--bypass` on `pr merge`, `pr close` (each rolled
  pull request, with its one comment naming the merge commit), and
  `pr comment` on the root pull request, the last only for the refusal
  comments this skill prescribes at a **Stop** and for replies to automated
  review findings on the root, and nothing else: no review, no review
  request, no label, no body edit. Without the no-review authorization, a
  refusal from branch protection for a missing approval is NOT bypassed:
  comment the refusal on the root, mark the campaign complete, report it.
  The comment is two or three plain sentences: what landed on the branch
  (the merge commit, the CI state), the exact refusal GitHub printed, and
  that nothing was forced (no admin merge, no auto-merge, no protection
  change). Read it back after posting and report its URL to the supervisor.
- **Fail**: an Expect not observed, or a red CI check on the head →
  separate environment faults (stale image, held port, leftover container,
  lapsed cache, a stub not running) from bugs in the rolled code; correct
  the former and re-run; fix the latter on the root branch in its own
  commit with a test, push, wait for CI as **Update** says, re-run the
  failing step and every step after it, then go on to **Answer** and
  **Ready** and, on an explicit merge order, **Merge**. An Expect or a check
  that still fails after a genuine fix is a refusal no fix can clear: no
  merge, a comment on the root naming the step, the output and the fix
  attempted, campaign complete, supervisor told. The comment is two or
  three plain sentences: what landed on the branch (the merge commit and
  the fix commit, the CI state), the failing step with its output and the
  fix attempted, and that nothing was forced (no admin merge, no
  auto-merge, no protection change). Read it back after posting and report
  its URL to the supervisor.
- **Stop**: the row stops for only three reasons: a push to the root branch
  by someone else, whose intent is unknown; a person's review or comment on
  the root posted after the row launched, found by the person check in
  **Answer**; and a refusal that no fix and no granted bypass can clear. A
  foreign push and a refusal each get the refusal comment on the root (a
  foreign push in the **Merge** format, naming the foreign commit and its
  author in place of GitHub's refusal) and a report to the supervisor; the
  Lord is never asked. A person's comment gets no comment at all: the row
  merges nothing, pushes nothing further, replies to no one, and marks the
  campaign complete, with REPORT.md saying "not merged: a person commented
  during the merge" and giving each comment's URL, author, time and first
  lines; the supervisor is told, so the Regent tells the Lord. The Lord
  decides; the row never asks him, and the Stager files any follow-up on his
  word. Anything else keeps the row going until the root merges, or, without
  a merge order, until it is ready for merge. A missing human approval that
  `--admin` cannot clear, because branch protection enforces approvals for
  admins too or the bypass list excludes the Lord, is such a refusal, and it
  ends the row as done (Lord, 2026-10-07: "alphas should not wait for PR
  approval if the repo doesnt allow human approval bypass despite being
  authorized by me, just mark the work as done"): once everything a fix can
  reach is done (branch up to date, CI green, criteria proven, body
  accurate), post the refusal comment once in the **Merge** format, leave
  the pull request open and ready for review, and mark the campaign complete
  with REPORT.md recording "delivered, not merged: waiting only on a human
  approval" plus the head sha. Never poll `reviewDecision`, never wait, and
  never ask the Stager to file a row that watches for the approval.
- **Identity**: commits in the target repository carry that repository's
  identity; `git var GIT_COMMITTER_IDENT` is checked before every commit,
  because the throne session injects another one.
- **Serialise**: two roll-ups that share a local stack (the same ports, the
  same compose project) run one after the other; say so to the Regent.

### When the root is staged in Forgejo

Outside a repository that lands on main (below), Forgejo is only the
staging area, and nothing is merged there (Lord, 2026-10-07: "nothing gets
merged in forgejo"). There, `throne forge pr merge` refuses a Forgejo pull
request. A staged root is the same row as above,
entirely on GitHub: roll, prove and, on an explicit merge order, merge the
GitHub pull request with the `gh` flow above. Only after an actual merge,
right after reading it back as `MERGED`, close its Forgejo twin:

```bash
throne forge close-merged-twin <root url>
```

It reads GitHub only to confirm the merge and writes nothing there. It
comments "This pull request has been merged on the GitHub side: <root url>"
on the Forgejo pull request and closes it, never merges it. A twin that is
already closed gets no second comment, so running it twice is safe. The
Lord's merge order covers this one Forgejo write.

### When the repository lands on main

A repository whose git config sets `throne.forge.landsOnMain` to `true`
keeps its pull requests only in Forgejo; GitHub only ever holds its `main`
(Lord, 2026-10-22: "when we /pr-merge, changes go straight to main ... so no
oull requests on github"). Check it in the local checkout:

```bash
git -C <repo> config --type=bool --get throne.forge.landsOnMain
```

`true` means this section applies; no output means it does not. Linked
worktrees share the key with their main checkout.

For such a repository the Lord's /pr-merge is itself the order to merge:
`RULINGS:` quote it as the merge order, and the row always ends with
**Merge**. The criteria is asked and defaulted as in step 2.

`stack.mjs` reads a stack only on GitHub, so find the stack in Forgejo:
`throne forge pr view <url>` prints a pull request's `baseRefName`; follow
it upward until the base is the default branch to find the root, and
`throne forge pr list --repo <repo>` with a `pr view` of each pull request
lists the open ones based on a branch in the stack. Roll-up order is the
same: nearest layer first.

The row then runs as above, with these changes:

- **Roll**, **Update**, **Self-review** and **Prove** run as above. The
  root branch is pushed to Forgejo with
  `throne forge push-branch --branch <root branch>`, never to GitHub. Each
  rolled pull request gets its one comment naming the merge commit through
  `throne forge pr comment`; no forge operation closes it, so it stays open
  and REPORT.md lists it for the Lord to close. There is no GitHub check:
  the build, tests and lint the row runs on the final head are what "CI
  green" means here.
- **Answer** and **Ready** do not run: there are no GitHub reviews to
  answer, no GitHub twin to repromote and no draft to clear. The `gh`
  grants above do not apply, because nothing is sent to GitHub.
- **Merge** is the landing, in place of every `gh` command and of
  `close-merged-twin`:

  ```bash
  throne forge pr merge <forgejo root url> --squash
  ```

  `throne forge land <forgejo root url>` is the same landing. It refuses a
  pull request whose base is not the default branch. It fetches `main` from
  `origin` and the head from Forgejo, squashes the head into one commit on
  top of `origin/main` in a scratch worktree outside the checkout, and
  signs that commit (`git commit -S`), with the pull request's title, its
  `WIP: ` prefix and `[GH-…]` marker removed, as the subject and a plain
  summary of its body as the body. It pushes the commit to `origin` `main`
  and then to Forgejo's `main`, never forced, comments
  `Landed on main as <sha>` on the Forgejo pull request and closes it as
  merged: Forgejo's manual-merge mark records the landed commit as the
  merge, and Forgejo makes no commit of its own. It prints
  `{"forgejoUrl","landedCommit","base":"main","closed":true}`. Read it
  back: `git -C <repo> ls-remote origin main` names `landedCommit` and
  `throne forge pr view <forgejo root url>` shows the pull request
  `MERGED`.
  REPORT.md records the landed commit.
- **A refusal is reported, never forced.** A squash that conflicts with
  `main` refuses, listing every conflicting path, and ends "Nothing was
  changed.": nothing was pushed or commented. Report it to the supervisor
  with those paths, as a **Stop**.
- **Signing stays on.** The landed commit is signed with the repository's
  own signing settings, and a signing failure refuses with nothing pushed.
  Never pass `--no-gpg-sign` or turn `commit.gpgsign` off to get past it;
  a pinentry that times out in a terminal with no desktop display is fixed
  by restarting the gpg agent from the desktop session.

## 4. After the merge

A row with no merge order ends at **Ready** with the root open, and nothing
below applies to it.

GitHub retargets nothing, because the rolled pull requests are already
closed. Delete the stack's branches only when the Lord says so; the row
leaves them (`--delete-branch=false`) so a revert can be re-derived.

A row that ended at an approval-only refusal (**Stop**) is finished too:
the pull request now waits on humans, so file nothing that waits or polls
for the approval.

## Worked shape

A three-layer stack: root `add/saved-search-store` (base `main`), then
`add/saved-search-page` (base the root's branch), then
`add/saved-search-endpoint` (base the second). Invoked with the top pull request's url; the script names the root
and prints `roll-up order into #<root>: #<second>, #<top>`. The Lord's
words: "if Scenario 1 of the top pull request passes, squash and merge it",
so the criteria is Scenario 1 and the merge is ordered. The row merges the
top's head into the root (it already contains the second), runs Scenario 1,
squash-merges the root, closes the other two with a pointer comment. One
commit on `main`; one revert if the feature is ever unwanted. Had he said
only "roll it up", the row would end at **Ready** after Scenario 1 and
**Answer**, with
the root open, ready for merge and out of draft.
