---
name: pr-merge
description: 'This throne-only, STAGER-ONLY skill lands a stack of pull requests the way the Lord prefers: identify the whole stack from any one pull request in it, roll every upper pull request into the root, prove the human scenario the Lord names on the rolled branch, and squash-merge the root through GitHub so the feature lands as one revertable commit. Invoked by /pr-merge <pull request url>, or when the Lord says "roll up this stack", "merge this stack", "land these PRs", "roll all PRs stacked on N into it", or "squash and merge N once scenario M passes". It asks the Lord three things (which pull request, whether it may merge, the criteria that allow the merge) and then files one queue row; only the Lord orders a merge.'
version: 1.0.0
user-invocable: true
---

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

Read the output for two things before asking the Lord anything: a root that
is `CONFLICTING` against the default branch (the roll-up needs a merge from
the default branch first), and a layer whose review decision is not
`APPROVED` (the Lord decides whether that blocks the merge; branch
protection may decide for him).

## 2. Ask the Lord three things, and only these

Every invocation records the Lord's answers under `RULINGS:` in his words:

1. **Which pull request** — the url he gave, and the root the script found,
   so he confirms the stack is the one he means.
2. **Do we allow it to merge?** — yes, or no (roll up and prove only,
   leave the root open).
3. **What is the criteria that allows the merge?** — usually "Scenario N of
   pull request M passes on the rolled branch", sometimes "tests and lint
   only", sometimes several scenarios. The criteria is what the campaign
   proves and what the merge waits on; write it verbatim.

When the Lord already said all three in the order that invoked this skill
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
- **Prove**: run the criteria exactly as the named pull request's body
  states it, every step, with the browser steps through the `agent-browser`
  skill and one screenshot per Expect, logs and screenshots under the
  Alpha's data directory (never committed; media commits need the Lord's
  explicit approval).
- **Merge**: every Expect observed → `<gh> pr merge <root> --squash
  --delete-branch=false`, then read the pull request back and confirm
  `MERGED` and the squash commit on the default branch. The throne gh guard
  denies mutations by default; the Lord's merge order authorizes `--bypass`
  on `pr merge` and `pr close`, and nothing else. A refusal from branch
  protection (missing approval, failing required check) is NOT bypassed:
  comment the refusal on the root, mark the campaign complete, report it.
- **Fail**: an Expect not observed → separate environment faults (stale
  image, held port, leftover container, lapsed cache, a stub not running)
  from bugs in the rolled code; correct the former and re-run; fix the
  latter on the root branch in its own commit with a test, re-run the
  failing step and every step after it, then merge. Still failing after a
  genuine fix → no merge, a comment on the root naming the step, the output
  and the fix attempted, campaign complete, Regent told.
- **Identity**: commits in the target repository carry that repository's
  identity; `git var GIT_COMMITTER_IDENT` is checked before every commit,
  because the throne session injects another one.
- **Serialise**: two roll-ups that share a local stack (the same ports, the
  same compose project) run one after the other; say so to the Regent.

## 4. After the merge

GitHub retargets nothing, because the rolled pull requests are already
closed. Delete the stack's branches only when the Lord says so; the row
leaves them (`--delete-branch=false`) so a revert can be re-derived.

## Worked shape

A three-layer stack: root `add/saved-search-store` (base `main`), then
`add/saved-search-page` (base the root's branch), then `add/saved-search-endpoint` (base the
second). Invoked with the top pull request's url; the script names the root
and prints `roll-up order into #<root>: #<second>, #<top>`. The Lord's
criteria: "Scenario 1 of the top pull request passes". The row merges the
top's head into the root (it already contains the second), runs Scenario 1,
squash-merges the root, closes the other two with a pointer comment. One
commit on `main`; one revert if the feature is ever unwanted.
