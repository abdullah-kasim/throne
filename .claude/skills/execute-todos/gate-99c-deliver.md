# The 99c deliver gate

#### `99c` — merge the latest target, resolve conflicts, deliver

Only after explicit `99bs` PASS, `99c_deliver_<topic>.md` runs as the final fresh
real Shadow, and it owns delivery together with the conflicts delivery hits. It
uses **plain git throughout** — no `absorb-git-tree`, no `merge-git-tree`, no
throne merge tooling of any kind. Merge the recorded target branch INTO the
campaign branch in the Alpha worktree:

```bash
git -C "$alpha_worktree" merge "$target_branch"
```

Both branch arguments are local refs; outside a yolo repository this step
issues no `git fetch` and never names `origin/...` ("Yolo delivery" below says
what a yolo repository does instead). Bracket the live operation with path-qualified status,
tracked-diff, and untracked-content evidence so ambient dirt is unchanged —
plain git carries no stash-and-restore of its own, so the bracket is the only
protection that dirt has.

**A merge beyond a clean one runs the spec gate again.** The merge is beyond
clean when `git merge` stopped on a conflict or `99c` committed anything to the
campaign branch after the merge commit. Then, before delivering, `99c` runs
`gate-99bs-spec.md`'s steps itself for the areas that merge changed, and
commits the result on the campaign branch.

**`99c` owns the conflict resolution outright. It does not punt to the Alpha.**
Every conflict the absorb raises is `99c`'s to resolve, on the campaign branch,
by reading both sides and deciding — never returned upward as a finding, never
left for a corrective slice, never handed to a fresh Shadow. A merge conflict is
the expected content of this assignment, not an obstacle to report. Escalate only
if resolving it would require a decision the bundle never made — a genuine
semantic fork between two landed slices — and say exactly which two.

It resolves every conflict there — on the campaign branch, never on the way
past and never on the target — re-runs the bundle's checks on the merged
result, then re-reads the target HEAD and repeats that absorb-and-recheck cycle
for as long as the target keeps moving. Only when the campaign branch is current
with a target whose HEAD is unchanged since that final check may it deliver.
Resolving on the campaign branch is what keeps the target free of half-merged
states. Those checks carry `99b`'s slow-test and container-test decisions and
their results forward under the carry rules of "Three verification layers";
`99c` does not decide them again.

Before any real integration it proves the merge in a private copy of the
recorded target repository by the rehearsal procedure below, and records the
absorbed target HEAD; the real round proceeds only while the live target branch
still equals that recorded HEAD. Then deliver with plain git — check out the
target branch in the live target repo and merge the campaign branch into it:

```bash
git -C "$repo" checkout "$target_branch"
git -C "$repo" merge --no-ff "$ALPHA" -m "<delivery message>"
```

A target that moved during rechecking sends the loop round again; `99c` never
fast-forwards a target it has not checked against.

Merge exactly once for one integration round, inspect the resulting target diff
and content, and run meaningful named smoke checks of the delivered feature on
the target. Then prove delivery with plain git rather than asserting it: show
the campaign's commits reachable from the target tip and an empty diff over the
delivered paths, and paste that exact output into the report.

```bash
git -C "$repo" log --oneline "$target_branch" | head
git -C "$repo" diff "$ALPHA".."$target_branch" -- <the campaign's touched paths>
git -C "$repo" rev-parse --abbrev-ref HEAD
```

A `**Delivery outcome:** PASS` without that cited output is not a valid terminal
report, and a non-empty diff over the delivered paths — or a target left checked
out on the wrong branch after the merge — forces FAIL.

**This is not merely a reporting convention: `complete-agent` and `reap-agent`
independently re-run a path-wise candidate/target tree-identity proof
(`checkTerminalDeliveryPrecondition` in `agent-evidence-gate.ts`) against the
live git state at completion time, for every delivery-shaped Shadow, regardless
of what the report claims.** That check reads the campaign's recorded
provenance and compares git state; it does not care which command performed the
merge, so a plain `git merge` that genuinely landed the content satisfies it
exactly as the retired tooling did. Pasted git output that was fabricated, or was
true when pasted but has since gone stale, does not substitute for it —
completion is refused until the real check, re-run right now, agrees. (See
`HDL_DELIVERY_PRECONDITION` — a `shadow-pln-99e` reported `**Delivery outcome:**
PASS` in prose having merged nothing to the target, and nothing forced the real
check at the time.)

It ends with exactly one `**Delivery outcome:** PASS` or `**Delivery outcome:**
FAIL`. `99c` is delivery plumbing: it must not repeat a landed integration to
prove it twice, demand or record SHA/history ceremony as merge proof, perform
commit-graph archaeology, or smuggle in a second validation ceremony.

**After the PASS: ask for the release of every row waiting on this
objective.** When your launch situation brief has a "Deferred rows waiting on
this objective" section, you — the Alpha, not the `99c` Shadow — send each
release request it lists, with `<sha>` filled in, once `99c` reports
`**Delivery outcome:** PASS` (and, for a pull request, its CI is green). Wait
for every "Released <code>" reply as that section says before you write
`REPORT.md` and report DONE. No section, no step.

Never leave the live target in a conflicted merge state. An unexpected conflict
during real integration is abandoned, the target is returned to its pre-merge
baseline, and delivery is re-proved from a fresh private copy before any further
attempt. A live abort is not treated as a proven-safe undo — the rehearsal
exists to make a live conflict and abort unnecessary.

**A blocked push is fixed or waived, never skipped another way.** When the
push checks refuse a push this delivery makes, fix what they report and push
again. Only when every finding is not a defect in the branch being pushed —
another open PR adds the code, the behaviour is unchanged on the base, or the
finding is wrong — record that proof with `throne push-waiver`
(`agent_docs/commands.md`, push-waiver) and run the one push command it
prints. Never reach for `--no-verify`, `PUSH_CHECK_SKIP=1` or `--bypass` on
your own say-so; the guard refuses them with exit 68. The waiver covers that
one commit only, so a later commit needs a new check run. The DONE report
carries the waiver's path and every entry it printed (finding, reason,
evidence), so the reader can check each certification.

#### Yolo delivery — when the repository pushes its default branch

A repository is a yolo repository when its git config sets `throne.yolo` true:
`git -C "$repo" config --type=bool --get throne.yolo` prints `true`. Its
campaigns still work on their own branches, but a campaign there is delivered
only once its head is on `origin/<default>`, where `<default>` is the branch
`refs/remotes/origin/HEAD` names. Open no pull request. Once the campaign is
merged into its recorded target branch as above, the steps, in order:

```bash
git -C "$repo" fetch origin
git -C "$repo" checkout "$target_branch"
git -C "$repo" merge "origin/$default"
git -C "$repo" checkout "$default"
git -C "$repo" merge "$target_branch"
git -C "$repo" push origin "$default"
```

1. Fetch origin.
2. Merge `origin/<default>` into the campaign's recorded target branch, and
   resolve every conflict there.
3. Merge the target branch into `<default>`.
4. Run the build, the tests and the lint on that merged commit. In the throne
   that is `bun run build`, `bun run test` and `bun run lint`; never the heavy
   tier. Elsewhere it is the repository's own commands.
5. `git push origin <default>`, never forced. If the push is refused because
   origin moved, fetch and go round again from step 2. Never `--force`.

Where the throne is the target, rebuild the live `dist/` with `bun run build`
in the live checkout after the merge.

It passes when, after a fresh fetch, `git -C "$repo" merge-base --is-ancestor
<campaign head> "origin/$default"` exits 0, and the commit now at
`origin/<default>` is the one that was built, tested and linted. `REPORT.md`
records that commit's SHA, the build, test and lint commands with their exit
codes, and the ancestry command's exit code. The `99c` file ends in `**Delivery outcome:** PASS at <full sha of the
commit now at origin/<default>>`.

`complete-agent` and `reap-agent --reason completed` refuse both the
delivering Shadow and the campaign Alpha while the campaign head is not on
`origin/<default>` after a fresh fetch, so this is a fence at completion, not
a refusal of any pull-request command.

#### Pull-request delivery — when the deliverable is a PR, not a merge

A campaign whose deliverable is a pull request (the queue row carries `pr:
<branch>` in its launch facts — `add-to-queue --pr-branch` / `update-queue
--pr-branch` — or the objective says "pull request" / "PR") delivers onto a
**human-named branch** and opens the PR from it. It never merges into the
repository's default branch, and it never pushes that default branch.

**A PR that builds on another open PR is stacked on it (Lord, 2026-10-05:
"please prefer stacked PRs").** A row naming a parent PR delivers onto its
own branch, which starts from the parent's branch the way `/pr-split`'s
execution contract says, and the PR opens with `--base <parent-branch>`.
Parent updates come into the branch by merge, never by rebase or force push.
When the PR already exists against another base, retarget its base to the
parent's branch before the first push: a host that runs pull-request CI only
on open, push and reopen starts no run for a base change, so a push made
before the retarget leaves the PR with no checks. The PR body names the PR
it is stacked on and says "merge after #<parent>". A row with no parent PR
branches from the default branch and opens against it. A stack lands through
`/pr-merge`.

**Branch names are the human author's, never the court's.** The PR branch is
named for the change in the repository's own convention — `add/podman-support`,
`fix/proxy-port-scan`, `update/vendored-fork` — and is set by the Stager at
filing (`--pr-branch`). It must not contain `alpha`, `shadow`, an objective
code, an agent name, a campaign or slice number, or any other piece of throne
machinery. The same rule covers the PR title, the PR body and the commit
messages the PR carries: they read as the repository's own contributor wrote
them, name what changed and why, cite files and tests, and mention no roles, no
agents, no bundles and no gates. If the campaign branch (`$ALPHA`) carries
commits whose messages name throne machinery, `99c` squashes or rewords them
onto the PR branch before pushing; the campaign branch itself is never pushed.

**The normal shape (filed under this law).** The Stager created the PR branch
from the default branch, or from the parent PR's branch for a stacked row,
before filing and recorded it as BOTH `--target-branch` and `--pr-branch`, so
the recorded target branch *is* the PR branch. `99c` then runs exactly the
delivery above — rehearsal, merge into the recorded target with plain git,
proof — and continues:

The title and `<body.md>` are composed with the throne's own `/pr-description`
skill (`.claude/skills/pr-description/`): six sections, with a hidden
`## Sequence` diagram of the change's runtime flow after `## How`, left out
when the change has no such flow, and a `## Testing`
walkthrough of numbered steps a reviewer who did not watch the work follows
literally, plus the mandatory **Not tested** alert, then a hidden
`## Agents` section holding the steps an AI agent follows to stand the
change up for the reviewer, run from a fresh worktree before the PR is opened:
its Spin up leaves the preview running for the reviewer to test, and its Spin
down removes it only when the reviewer says they are done. `## Agents` is the
last section unless a `## Ticket Status` section closes the body. A UI change also carries a `## Screenshots` section whose files were captured
with `/pr-media` (`.claude/skills/pr-media/`, driven by `/agent-browser`) and
left under `~/tmp/pr-media-<pr>/`, never committed; the reviewer reads the PR
and watches the recording instead of opening an editor.

When the bundle's `ticket-warning.md` holds a warning block, `99c` publishes
it verbatim at the very bottom, after `## Agents`, as the Ticket Status section
`/pr-description` describes. When it holds `no warning needed`, the body has
no `## Ticket Status` section at all.

The push, the PR and the proof all go through `throne forge`, the one place
the court decides where a pull request lives:

```bash
throne forge push-branch --repo "$repo" --branch "$target_branch" --base <default branch>
throne forge pr create --repo "$repo" --draft --base <default branch> --head "$target_branch" \
   --title "<what changed, as the contributor would say it>" --body-file <body.md>
throne forge pr view "$target_branch" --repo "$repo"
```

On a host where Forgejo is installed, the push makes the repository's Forgejo
copy when it has none and the draft PR lands in Forgejo, the Lord's staging
area. It reaches GitHub only through `/pr-promote` on the Lord's word; `99c`
never promotes. On any other host the seam runs the commands this delivery
ran before, from inside `$repo` rather than with `-R`:

```bash
git -C "$repo" push -u origin "$target_branch"
gh -R <owner>/<repo> pr create --draft --base <default branch or parent-branch> --head "$target_branch" \
   --title "<what changed, as the contributor would say it>" --body-file <body.md>
gh -R <owner>/<repo> pr view "$target_branch" --json url,isDraft,headRefName,baseRefName
```

A push the checks block follows the `99c` rule above: fix it, or waive it with
`throne push-waiver`, and the PR-delivery report carries the waiver's path and
its entries.

The PR is opened as a **draft** unless the objective says otherwise. The body
carries what the objective's `INTENT:` asked for (findings, tests run, what is
not covered) in the contributor's voice. Paste the `throne forge pr view` JSON
into the report; on both forges it carries `url`, `isDraft`, `headRefName` and
`baseRefName`. A `**Delivery outcome:** PASS` for a PR-shaped campaign without a PR URL
and `"isDraft": true` (when a draft was asked) is invalid. The
`checkTerminalDeliveryPrecondition` proof is unchanged and still passes: the
campaign landed on its recorded target branch, which is the PR branch.

**The legacy shape (row filed with the default branch as target, `pr:` added
later).** Deliver into the recorded target branch *locally* exactly as above —
that is what the recorded provenance and the terminal precondition verify —
then move the PR branch to that tip and push only the PR branch:

```bash
git -C "$repo" branch -f "$pr_branch" "$target_branch"
throne forge push-branch --repo "$repo" --branch "$pr_branch"
```

On GitHub the push is `git -C "$repo" push -u origin "$pr_branch"`. On both
forges the PR then opens through `throne forge pr create` as in the normal
shape. On a Forgejo host it still shows the delivered changes because the seam
takes the Forgejo base from `origin/<default>`, never from the local default
branch that already holds the delivery merge.

Never push the default branch in this shape; say in the report that the local
default branch is ahead of `origin` by the delivery merge, so the human can
`git reset --hard origin/<default>` once the PR lands. Prefer refiling under the
normal shape whenever the campaign is young enough that a cancel costs little.

#### Rewriting a published PR branch — when a force-push is right

Delivery appends. A force-push is the exception, and two separate questions
gate it: whether it is permitted, and whether it is the right tool. Both are
answered before the push, and the answers go in the report.

**Permitted.** The Lord, 2026-09-17: "if the PR belongs to us, force push is
authorized unless someone else has committed to it. then you create another
branch to sidestep the issue", and, as a standing rule, "further force pushes
if the PR belongs to us is authorized as long as the latest commit is ours".
So no per-campaign authorization is needed. Prove ownership first:

```bash
git -C "$repo" fetch origin "$pr_branch"
git -C "$repo" log --format='%h | %an <%ae> | %cn <%ce> | %s' \
    "$base".."origin/$pr_branch"
```

The latest commit must be ours. If it is not, do not fight the branch: the
Lord's own fallback is to open a separate branch and sidestep it. Say in the
report which commits carried another author.

**The right tool.** The Lord, same day: "it depends why we are force pushing.
if it needs it, then sure. if actually pulling first is the better option,
then pull first. you gotta check the code and compare before force pushing."
Permission is not a reason. Compare first, then write one of these two
sentences in the report, and if neither is true, do not force-push:

- *Rewriting shape, content unchanged* — squashing, dropping empty commits,
  removing a merge commit or a message that leaked an orchestration word.
  Prove it by tree hash before anything moves:
  `git -C "$repo" rev-parse <new-tip>^{tree}` must equal
  `git -C "$repo" rev-parse origin/$pr_branch^{tree}`. Equal trees mean the
  push cannot lose a byte.
- *Adding content on top of a remote we already contain* — the remote holds
  nothing absent locally, confirmed with
  `git -C "$repo" log --oneline "<local-tip>..origin/$pr_branch"` printing
  nothing.

If the remote is ahead in content, pulling, merging or rebasing onto it is the
correct move and a force-push would destroy work. Pulling first is the default
whenever that is true.

**The push itself** always carries a lease pinned to the sha we believe is
published, so it refuses rather than races:

```bash
git -C "$repo" push --force-with-lease="$pr_branch:<known-remote-sha>" \
    origin <new-tip>:"$pr_branch"
```

A refused lease means the remote moved while we were deciding. Stop, report it,
and re-run both questions against the new tip; never answer a refused lease
with a bare `--force`. After the push, re-verify and record in the report: the
remote tip, the tree hash unchanged when the claim was "shape only", the commit
list, and that the PR is still a draft with its body intact.

**Do not create the mess in the first place.** The rewrite above was once needed
on a delivered PR because a delivery round published two empty commits recording
that checks passed, plus a merge commit whose subject named a Shadow. Empty
stamps also poison the next round's delivery proof:
`checkTerminalDeliveryPrecondition` anchors on the recorded delivery commit, and
an empty one makes every later path-wise comparison read as unproven. Every
commit a gate adds touches at least one file, carries no orchestration
vocabulary, and leaves no `# Conflicts:` block in its message.

#### The delivery rehearsal — absorb the target inside a private copy

**Where the copy lives.** A clone of the recorded target repository, never a
linked worktree of it: a linked worktree shares the live repository and puts the
live checkout one command away from a conflicted state. Every input is read from
the campaign's `data/$ALPHA/tree-base.json`, whose two branch-shaped fields are
easy to invert: `branch` is the TARGET branch
(`src/nest-commander/spawn-git-tree/spawn-git-tree-runtime.ts` owns campaign
tree-base recording, and
`src/merge-git-tree/merge-git-tree-runtime.ts` passes the
recorded branch to `mergeBack`, named `targetBranch` in
`src/git-lifecycle/merge.ts`),
while `name` is the CANDIDATE branch — the Alpha's own branch, recorded by
the Nest Commander `spawn-git-tree` runtime. Clone into scratch outside every live
checkout:

**Naming convention for this and every other `$HOME/tmp` clone a terminal
Shadow creates:** prefix the dirtemp name with your own agent name, then a
purpose word — `<your-agent-name>-99c-rehearsal-XXXXXX` below, matching this
repo's existing `mkdtempSync(path.join(root, prefix))` idiom (e.g.
`src/create-agent/custom-harness.service.ts`). Reap-agent's teardown globs
`$HOME/tmp/<agent-name>-*` to find and remove its own scratch at reap time,
which only works if the prefix names the owning agent.

```bash
alpha_tree_base="$THRONE_DATA/$ALPHA/tree-base.json"
repo="$(jq -r .repo "$alpha_tree_base")"              # the recorded target repository
target_branch="$(jq -r .branch "$alpha_tree_base")"   # `branch` = TARGET branch
candidate_branch="$(jq -r .name "$alpha_tree_base")"  # `name`   = CANDIDATE branch
live="$repo"                                          # the live target checkout
mkdir -p "$HOME/tmp"                                  # never /tmp: a reboot wipes
agent_name="<your own herdr agent name>"              # the prefix reap-agent globs on
sim="$(mktemp -d "$HOME/tmp/${agent_name}-99c-rehearsal-XXXXXX")"  # the pre-images mid-recovery
git clone --no-hardlinks "$repo" "$sim/copy"
git -C "$sim/copy" checkout "$candidate_branch"   # the Alpha branch, not the target
git -C "$sim/copy" config commit.gpgsign false    # rehearsal commits are thrown away
git -C "$sim/copy" var GIT_COMMITTER_IDENT >/dev/null 2>&1 || {
  # A clone inherits no identity from the source repo's own .git/config, and a
  # merge that needs a merge commit dies without one.
  git -C "$sim/copy" config user.name "$(git -C "$live" config user.name)"
  git -C "$sim/copy" config user.email "$(git -C "$live" config user.email)"
}
```

**The copy's lifetime.** `$sim` is created before the first absorb and deleted
only after the real round's post-checks pass, or after a recovery restoration
has completed. Nothing earlier may delete it: it holds the inventory AND the
only surviving copy of the live target's pre-operation bytes. It lives under
`~/tmp`, never `/tmp`, so a reboot mid-round cannot wipe the pre-images before
restoration runs.

**The absorb loop.** The copy holds the candidate and absorbs the target; the
target itself is never touched here.

```bash
git -C "$sim/copy" fetch origin "$target_branch"
git -C "$sim/copy" merge FETCH_HEAD      # target absorbed INTO the candidate
<the bundle's merge-result checks>       # run on the absorbed result
```

Repeat fetch → merge → check until a freshly fetched `FETCH_HEAD`
merges with `Already up to date.` and no iteration hit a conflict. That pair is
the definition of "proved"; a conflict is a block, not a step of the loop. These
iterations happen inside the copy and are NOT integration
rounds — they never count against the merge-round tripwire in Rule 6.

**Why a clean absorb is evidence about the live round.** The absorb joins the
target tip into the candidate inside the copy; the real round joins those same
two tips the other way round on the live repository. Same merge-base, same two
tips, therefore the same conflict set — so a conflict-free absorb whose checks
pass is evidence that the real round is conflict-free too. It is not the same
commit and nothing from the copy is shipped: the real round performs its own
three-way merge of the untouched Alpha branch. The rehearsal proves a merge; it
does not manufacture one.

**The recorded value.** `absorbed_head="$(git -C "$sim/copy" rev-parse
FETCH_HEAD)"` — the target commit the copy proved against. Write it into the
delivery todo's execution log _before_ any real integration; an unrecorded
absorbed HEAD means the rehearsal proved nothing checkable.

**The delivery precondition.** Real integration proceeds only while
`git -C "$live" rev-parse "$target_branch"` still equals `$absorbed_head`. If
the target moved, the copy absorbs the new tip, the merge-result checks run
again, and the recorded HEAD is replaced before delivery is attempted.

**The failure gate.** A conflict at any absorb iteration or a failing
merge-result check in the copy blocks real integration until `99c` fixes it. Do
not resolve it _in the copy_ and do not resolve it _on the live target_ — the
copy is disposable and the target is not yours to half-merge. Resolve it where
resolution belongs: absorb the target into the Alpha branch for real, in the
Alpha's own worktree, which touches no live target, resolve the conflicts and
repair the failing checks there **yourself**, then rehearse again from a fresh
clone. The rehearsal copy resolves nothing anywhere; `99c` resolves everything
on the campaign branch. This is not a hand-off to ordinary Shadows or a re-gate
— that was the old five-gate route, and it is closed.

**The recovery path.** If the real round conflicts anyway, abort it yourself —
plain git leaves the merge in progress rather than unwinding it for you, so run
`git -C "$repo" merge --abort` as the first action. Then confirm the live target
carries no in-progress merge and matches its pre-merge baseline, restore from the
recorded pre-images whatever the diffs report, and start a fresh clone and absorb
loop.

```bash
# --absolute-git-dir, not --git-dir: the latter commonly answers a bare `.git`,
# which then resolves against the executor's cwd — a Shadow worktree whose own
# `.git` is a file — and the MERGE_HEAD test passes over a live mid-merge.
git_dir="$(git -C "$live" rev-parse --absolute-git-dir)"
test ! -e "$git_dir/MERGE_HEAD"                       # no in-progress merge
git -C "$live" status --porcelain --untracked-files=all >"$sim/inventory.after"
( cd "$live" && git ls-files --others --exclude-standard -z \
    | xargs -0r sha256sum ) >"$sim/manifest.after"
git -C "$live" diff HEAD --binary >"$sim/dirty.after.patch"
diff "$sim/inventory.before" "$sim/inventory.after"
diff "$sim/manifest.before" "$sim/manifest.after"
diff "$sim/dirty.before.patch" "$sim/dirty.after.patch"
  # Any difference is restored from the recorded pre-images, never by hand:
  #   git -C "$live" reset --quiet --hard HEAD
  #   tar -C "$live" -xf "$sim/preimage.tar"
  # Baseline first, then the recorded bytes over it. That restores content, not
  # index state; `inventory.before` records which paths were staged, and
  # `git add` re-stages them.
  # Re-run all three diffs until clean. $sim holds the only copy of those
  # bytes, so it is deleted only after they verify — and only then:
rm -rf "$sim"
```

Hand-resolving a conflict inside the live target is forbidden.

**The pre-operation inventory.** Before ANY merge or abort on the live target —
the copy is disposable, the live checkout is not — capture
a path-qualified dirty inventory and a content manifest, plus the bytes:
tracked modifications, staged entries, and untracked paths including the
recursive contents of untracked directories. A bare directory entry is not an
inventory, and a hash is not a restoration — a diff that proves a file changed
cannot put it back. Every path the inventory covers must also have recoverable
bytes recorded, or the restoration this procedure mandates is unsatisfiable.

```bash
git -C "$live" status --porcelain --untracked-files=all >"$sim/inventory.before"
# `xargs` inherits no `-C`: hash from inside $live or the names resolve against
# the executor's own cwd and hash unrelated same-named files.
( cd "$live" && git ls-files --others --exclude-standard -z \
    | xargs -0r sha256sum ) >"$sim/manifest.before"
# Hashes detect; only bytes restore. One archive carries every dirty path —
# untracked, tracked-modified, and staged alike:
{ ( cd "$live" && git ls-files --others --exclude-standard -z )
  ( cd "$live" && git diff HEAD --name-only --diff-filter=d -z ) ; } \
  | tar -C "$live" --null -T - -cf "$sim/preimage.tar"
git -C "$live" diff HEAD --binary >"$sim/dirty.before.patch"   # the tracked/staged detector
```

`status --porcelain` records state and path, never content: a tracked `M` file
whose bytes change from A to B while it stays `M` is invisible to the inventory
and absent from the untracked manifest. `diff HEAD --binary` is what closes
that hole, and it is also the only artifact from which those bytes come back.

After the operation, regenerate all three, `diff` them against the recorded set, and
restore anything that vanished or changed.

**Why the bracket, stated as observation rather than mechanism.** No loss
mechanism is asserted here, because none reproduces. On git 2.55.0 a
merge that would overwrite an untracked path refuses up front — exit 2, no
`MERGE_HEAD` written, the untracked bytes intact — whether the rest of the merge
is clean or conflicted, and whether or not the untracked bytes match the
incoming side; the abort is simply never reached. Note what `99c` gave up when
it moved to plain git: `mergeBack` (`src/git-lifecycle/merge.ts:60-84`) stashes
`--include-untracked` around the landing, so `merge-git-tree` exposed no
untracked file to its internal abort. A plain `git merge` has no such stash, so
the inventory bracket below is now the ONLY thing standing between a live abort
and the ambient dirt.
One live untracked-file loss has been reported in this repository's memory tree
under conditions nobody has since reproduced, which is a reason to bracket and
not a mechanism to restate. The inventory is therefore a cheap
bracket around a live mutation, not a defence against a demonstrated
deletion. Do not treat "the merge aborted cleanly"
as evidence that the working tree survived — that is unexamined, not proven.

**Structural preference.** Gate the live round on a conflict-free absorb so that a
live abort is never required. A live abort is the already-damaged path:
reachable, bracketed by the inventory, and followed by explicit restoration —
never the routine one.

**The absorb loop and the failing-merge tripwire are different mechanisms, and a
reader who collapses them breaks one of them.** The tripwire bounds a merge that
WILL NOT LAND: at most two rounds, the second only for a diagnosed fixable cause,
after which the Alpha merges by hand with plain documented git and files the
recurrence as a process defect. The absorb loop bounds nothing by a retry
counter: it re-converges on a MOVING TARGET and ends when the target goes quiet.
Applying the tripwire's two-round cap to the absorb loop caps a legitimate
re-convergence; applying the absorb loop's patience to the tripwire licenses
unbounded retries of a broken merge. Neither bound substitutes for the other.

**`99c` is the one gate that must not be pre-staged with verdict-dependent
content.** A delivery gate's payload depends on the verify verdict that precedes
it, so only verdict-independent preparation — target-branch resolution and
merge-base capture — may be pre-built. Launch still requires `99b`'s explicit
PASS plus the candidate-HEAD equality check the pre-staging rule already
mandates.

**Legacy compatibility.** A pre-amendment bare `99_validate_<topic>.md` remains a
historical validation gate. The two-gate `99a` verify-and-fix / `99b`
merge-and-deliver chain that preceded the 2026-08-25 renumber keeps its authored
meaning, as does a pre-amendment `99b_validate_<topic>.md` /
`99c_merge_<topic>.md` pair, and a pre-amendment five-gate bundle (`99a` absorb,
`99b` file-size, `99c` static analysis, `99d` validate, `99e` deliver) keeps that
authored chain too. Because the same letter means different things across these
generations, terminal gates are classified by their ROLE WORD, not their letter.
Run those legacy files with fresh terminal Shadows under
`rolePools.ShadowSlice99`; do not reinterpret or rewrite ledger history. New
bundles use only the `99a` → `99b` → `99bs` → `99c` chain
above.

**Fresh-worker independence, not provider identity or effort, is what makes a
gate strong.** Spawn both terminal gates using the request selected by
executable policy. Same-company and cross-company
workers are equally valid routes. A gate is a fresh reader on a clean context; it
takes the model's lowest available effort like every other fresh spawn. Do not
pin its effort, and do not "compensate" with `--bypass-effort`.

`99b` re-runs the whole bundle's checks, not just the slices' own: a slice can
pass its own deliverable while the assembled candidate still breaks (an
integration seam nothing tested, a criterion no slice actually covered). That is
what running the suite over the assembled tree catches, and what `99b` then
fixes. Surface the result in the final verification matrix — a criterion the
bundle never covered is a real follow-up, not a footnote.
