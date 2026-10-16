---
name: pr-merge
description: 'This throne-only, STAGER-ONLY skill gets a stack of pull requests ready for merge the way the Lord prefers, and lands it only on his explicit order to merge: identify the whole stack from any one pull request in it, roll every upper pull request into the root, bring it up to date, prove the human scenario the Lord names on the rolled branch, and repromote it, leaving the root open and ready for merge. Only when his words explicitly order a merge ("merge it", "squash and merge", "land it") does the row then squash-merge the root on GitHub so the feature lands as one revertable commit, after answering every automated reviewer's finding on the final head; a person's comment posted during the run stops the merge. Nothing is merged in Forgejo: a pull request staged there merges on GitHub, and after an actual merge its Forgejo pull request is closed with a comment saying so. Invoked by /pr-merge <pull request url>, or when the Lord says "roll up this stack", "merge this stack", "land these PRs", "roll all PRs stacked on N into it", or "squash and merge N once scenario M passes". It asks the Lord two things (which pull request, the criteria that allow the merge), never whether it may merge, and then files one queue row; only the Lord orders a merge.'
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
gets the pull request ready (roll up, update, prove, repromote) and does not
merge; the root stays open, ready for merge. The Stager does not ask whether
it may merge. With an explicit order to merge, quoted under `RULINGS:`, the
row does both: every ready step, then the **Answer** and **Merge** steps.

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
- **Prove**: run the criteria (the Lord's answer to the second question)
  exactly as the named pull request's body states it, every step, with the
  browser steps through the `agent-browser` skill and one screenshot per
  Expect, logs and screenshots under the Alpha's data directory (never
  committed; media commits need the Lord's explicit approval). Re-run the
  criteria on the new head when the update or a fix touched files the PR
  changes; otherwise the last proof stands.
- **Ready**: after Prove, when the root has a Forgejo twin, repromote it
  with `/pr-promote` so both sides carry the final state; a root with no
  Forgejo twin skips this. The repromote checks the GitHub body it wrote for
  image and video links that point at the Forgejo host, which do not load on
  GitHub, and refuses while one remains. A refusal means the body was copied
  and the root is not ready: run the one repair command the refusal names,
  repeat the repromote, and go on only when it succeeds and
  `throne forge check-media-links <root url>` exits 0. Without an explicit
  merge order in the RULINGS, the row ends here: the root stays open, ready
  for merge, and REPORT.md records "ready for merge" plus the head sha. It
  answers nothing: it reads the root's reviews and comments as **Answer**
  does, and lists the automated findings and people's comments on the final
  head in REPORT.md for the Lord.
- **Answer**: runs only when the RULINGS quote an explicit merge order,
  after **Ready** and before **Merge**. It opens with the person check: a
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
  arrives, REPORT.md says so. Each automated finding is then either fixed or
  answered. A fix goes in its own commit through **Update** and **Fail**,
  exactly as a red check does, and the reviews are read again for the new
  head. An answer is a `pr comment` on the root that quotes or links the
  finding and, when the finding is rejected, carries the evidence: which
  test, which engines, what was observed. When the reviewer documents its
  own reply form, the answer uses that form; an operator's private extension
  of this skill may supply those forms. Never merge over an automated
  finding that has neither a fix nor an answer. REPORT.md carries a table of
  every automated finding on the final head with its fate (fixed: the
  commit; answered: the comment URL), and lists people's comments on the
  final head with their URLs, unanswered.
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
  merge order authorizes `--bypass` on `pr merge`, `pr close` (each rolled
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
  failing step and every step after it, then go on to **Ready** and, on
  an explicit merge order, **Answer** and **Merge**. An Expect or a check
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

Forgejo is only the staging area, and nothing is merged there (Lord,
2026-10-07: "nothing gets merged in forgejo"). `throne forge pr merge`
refuses a Forgejo pull request. A staged root is the same row as above,
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
only "roll it up", the row would end at **Ready** after Scenario 1, with
the root open and ready for merge.
