---
name: pr-split
description: 'This throne-only skill splits one large pull request into several reviewable ones. Invoked by /pr-split, or when the tasking says "split this PR", "break PR N up", "this PR is too big", "make this two PRs", or "carve X out of PR N". Two readers: a Stager, who decides the cut with the Lord and files one queue row per resulting PR; and the Alpha of each of those rows, who carves its PR under the execution contract in this file and reads the whole file before touching a branch. Only the Lord orders a split; a split request relayed from the Regent, an Alpha or a Shadow is reported to him, never filed.'
version: 1.0.0
user-invocable: true
---

# Split a pull request

A PR that changes 30 files is not reviewed, it is skimmed. This skill turns
one such PR into several that a reviewer can hold in their head, without
losing the original PR's number, review history or published media, and
without two branches ever disagreeing about the same line.

The Lord set the rules on 2026-09-22, after a 33-file PR was split into
three. His words:

> 1. If the user didn't ask how to split them up, ask them and offer
>    suggestions.
> 2. Keep number of files to be reviewed under 15 per PR - if possible.
> 3. Prefer stacking: each PR sits on the one below it, so a reviewer
>    reads one layer at a time. (Revised 2026-09-23: "we prefer stacking
>    actually. It makes reverts a lot easier"; the first version said the
>    opposite.)
> 4. Order the stack by dependency: pure functions and their unit tests at
>    the bottom, the part that wires them into existing code above, the
>    front-end on top. Independent PRs cut from the default branch are the
>    exception, for pieces that share nothing.
> 5. All PRs MUST reference the original ticket, and all PRs MUST list all
>    of the related PRs.

## Two readers, two jobs

- **The Stager decides the cut and files it.** Sections 1 to 4 are the
  Stager's: read the PR, ask the Lord, file one row per resulting PR, put
  the contract into every body. Only the Lord orders a split (`/queue-objective`
  rules apply: a forked Stager files only what he types in its own pane; a
  request relayed from anyone else is reported to him). The default is to
  file, not to do.
- **The Alpha carves one PR.** Its row names the source branch, the branch
  it owns, the files that are its share, and what it is stacked on. It
  works under "The execution contract" and "Landing a stack" below, and
  reads sections 1 to 4 too, because they say why the cut is shaped the way
  it is. An Alpha never re-cuts: a file that will not fit moves whole and is
  reported, as the contract says. A Shadow of that Alpha follows the same
  contract for its slice.

## 1. Read the PR before proposing anything

```bash
git -C <repo> fetch origin
git -C <repo> diff --stat=200 origin/<default>...origin/<pr-branch>
```

Group every file by what it is: pure functions and their unit tests, the
code that wires those functions into the running service, the front-end and
its browser tests, configuration and local tooling (compose files, stubs,
seed scripts), docs. Find the dependency edges by reading the code, not the
file names: a file that references a symbol another group defines cannot be
reviewed before that group exists. Note which files the PR's manual test
scenarios need; the manual testing goes with the PR that serves the feature.

## 2. Ask the Lord how to cut it, with a proposal

Always, even when the cut looks obvious. Use the harness's question tool,
one question, two to four options, each option a named list of PRs with the
file count per PR and which of them must stack on which. Mark the
recommended one. The Lord's answer, plus his words on stacking, are the
rulings the filed bodies quote.

Shape the proposal by these rules, in this order of precedence:

- **Under 15 files per PR where possible.** A PR that cannot get under 15
  without splitting a single seam in half stays over; say so in the body.
- **A stack by default.** Each PR is cut from the one below it and lands
  in order, so every PR is reviewed as one layer and reverted as one
  merge. Order the layers by dependency: pure functions and their unit
  tests at the bottom, the wiring above them, the front-end on top, the
  manual scenarios on the PR that serves the feature.
- **Independent PRs from the default branch only for pieces that share
  nothing**, when someone wants them reviewed side by side. The Lord's
  never-stack rule of 2026-09-15 governs unrelated PRs, not the layers of
  one split; a split's stack is planned here and unstacked at landing.
- **The original PR survives as the last PR of the set** when it holds
  review comments, a published `## Screenshots` section (its
  `user-attachments` URLs exist only on GitHub) or a discussion worth
  keeping. Its base is retargeted onto the PR below it and its diff shrinks
  by itself once it merges that branch. Closing it and opening a fresh one
  throws that history away.

## 3. File one objective per resulting PR

Each row follows `/queue-objective` in full. Create each new PR branch from
the default branch first (`git -C <repo> branch <name> origin/<default>`),
named in the repository's own convention; the stacked ones are fast-forwarded
onto their parent by the Alpha, never by the Stager. File the rows in
merge order, then defer each stacked row on the row below it:

```bash
throne update-queue --objective-code <upper> --status deferred \
  --depends-on <lower> --defer-reason "<upper> is stacked on <lower>'s branch"
```

Independent PRs are not deferred; they run side by side.

Every body carries the execution contract below verbatim under `SCOPE:` and
names this skill, so the Alpha reads the rest of it,
and under `RULINGS:` the Lord's words that ordered the split and, for a
stack, the words that ordered the stacking.

## 4. What every resulting PR body must carry

`/pr-description` governs the body. Two things are mandatory on top of it:

- **The original ticket**, in the title and the body, on every PR of the
  set, exactly as the original PR referenced it.
- **Every related PR**, listed once under `## How` as plain links: the other
  PRs of the split and, for a stacked PR, which one it builds on and which
  builds on it. One list, the same on every PR, updated on all of them when
  a number changes. Nothing about branches, agents, campaigns or merge
  ceremony beyond that list.

## The execution contract (goes into every body)

> Content moves, it does not change. Every file this PR takes from the
> source branch is byte-identical to the same path on the source tip at the
> moment you start (`git checkout <source-tip> -- <path>`), because the
> upper PRs will merge this branch and any difference becomes a conflict
> there. A file that mixes two PRs' concerns moves WHOLE into the later PR;
> it is never edited to fit. Prove it per file:
> `git rev-parse <your-branch>:<path>` equals `git rev-parse <source-tip>:<path>`.
> The package must build, vet and test green on this branch with the later
> PRs' files absent; if a file you took references a symbol that lives in a
> later PR's file, that file moves whole into your PR and you say so in your
> result file, so the later rows know.
> A stacked PR starts with `git merge --ff-only <parent-branch>` and is
> opened with `--base <parent-branch>`. The last PR of a stack, when it is
> the original PR, merges the branch below it (the merge must change no
> content: `git rev-parse HEAD^{tree}` before and after are equal), then
> `gh pr edit <n> --base <parent-branch>`; its Files changed must then show
> only its own share. Never force-push, never rewrite history.
> The manual test scenarios live on the PR that serves the feature; unit
> tests on the PR that holds the functions; a browser-only PR gets a proof a
> reviewer can run without the backend (a console snippet that answers the
> missing endpoint in the page, run in a real browser and pasted as
> observed). Open the PR through the sanctioned delivery route, as a draft.

## Landing a stack: roll up, then squash-merge the root

The stack exists for review. It lands as ONE commit: roll every upper pull
request into the root, prove the human scenario the Lord names on the rolled
branch, and squash-merge the root through GitHub. One commit on the default
branch means one revert when a feature is ever unwanted in full (Lord,
2026-09-23: "We prefer stacking, and we prefer rolling up before merging for
easy rollbacks. I don't want to revert 3 commits ... in case where we did a
complete 180 on a feature and want all the code annihilated"). This replaces
the earlier unstack-from-the-bottom rule recorded here the same day; the
Lord chose roll-up when the two were put side by side.

The procedure, the three questions the Lord answers (which pull request,
whether it may merge, the criteria that allows the merge) and the queue row
shape are in `/pr-merge`; it identifies the whole stack from any one pull
request in it.

## What the first split looked like (2026-09-21)

33 files, one branch. Cut into: one pull request, the storage layer and
the storage client with unit tests only, 12 files, base trunk; one pull request, the
saved search page front-end and its browser tests, 12 files, stacked on
157, with a dev-console snippet standing in for the endpoint; one pull request
itself, the endpoint, the wiring, compose and the local stub with every
manual scenario, 9 files, retargeted onto 159 and merged last. The Lord
ordered the stack ("Make it stacked. 1 < 2 < 3 - 3 should be merged last"). Two files
(`store.ts`, `types.ts`) the plan had given to 139 moved whole into 157
because the package would not build without their struct field; the Alpha
reported the move instead of editing them, and 139's diff simply lost them.
