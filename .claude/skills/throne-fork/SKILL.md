---
name: throne-fork
description: 'This throne-only, Stager-only skill documents the `create-agent --fork-of <parent>` procedure that produces a real forked Stager, never a harness subagent. Invoked by the bare word "fork", "no alpha, fork", "fork this", "hand it to a fork", "spin up a fork", or "run it in a fork". Only a registered Stager may run it; the Regent cannot fork itself.'
version: 1.0.0
user-invocable: true
---

# Forking a Stager

0. Before acting on anything below, make sure the copy of this skill you are
   reading is current: the harness loads skill text from the invoking
   worktree, not from main, so an out-of-date worktree reads as a complete
   skill with no sign anything is missing. Fast-forward first —
   `git merge --ff-only main` — or read the current text straight from main:
   `git show main:.claude/skills/throne-fork/SKILL.md`.

## A throne fork is not a harness subagent

The harness has its own subagent mechanism that is also called a fork. This
skill is not that. A harness subagent is the "hidden in-harness worker"
`/no-alpha` step 2 forbids — it lives only inside the invoking harness
session, holds no registration, and vanishes with the pane. A throne fork
from this skill is a real registered Stager: its own pane, its own worktree,
its own model, its own ledger entry, addressable by name like any other
agent in the court. When the Lord says "fork", he means this one.

## The procedure

Only a Stager may take this path; the Regent cannot fork itself.

f0. Confirm the exact scope with the Lord, the same mandatory confirmation
    `/no-alpha` step 0 requires. Forking does not waive it.
f1. Write the brief to `~/.throne/data/<fork-name>/brief.md` in the
    four-marker shape (INTENT, SCOPE, RULINGS, VERIFIED-NOUNS) and check it
    with `throne lint-queue-plan --body-file <that path>`. THE FORKED PANE
    INHERITS NONE OF THIS CONVERSATION. Everything settled here — the
    rulings, the paths, the file names, the things ruled out — is lost
    unless it is in that file. Verify every code noun against the live tree
    before writing it, the same way `/queue-objective` does.
f2. Choose the fork's name as the invoker's own name plus a task slug
    (`stager-tenth-prmedia`), never a number.
f3. Prepare its worktree with `spawn-git-tree <fork-name> --repo <repo>
    --non-campaign`, then spawn it:
    `create-agent --fork-of <parent> --role Stager --supervisor <parent>
    --name <fork-name> --cwd <that worktree> --non-campaign`. Pass `--model`
    only when the Lord named one; otherwise it inherits the parent's live
    model. `create-agent` refuses and names the failing condition if
    anything is off.
f4. Tell the Lord the fork's name and where its pane is, and stay in the
    conversation. Do not follow it into the task.
f5. The fork reports DONE to the parent with `send-agent` and stays alive.
    Only the Lord reaps it.

## Sending the fork a ruling after it has started

The Lord keeps talking to you while the fork works, so rulings will land
that the brief does not hold. Relay each one as an ADDENDUM, never as a long
message:

a1. Write `~/.throne/data/<fork-name>/addendum-<number>-<topic>.md`,
    numbered in order. Open with whether it is a ruling and whether it
    widens, narrows, holds or cancels scope, then quote the Lord's words.
    Verify its code nouns exactly as you did for the brief.
a2. Send ONE line: `throne send-agent <fork-name> "<your-name>: read
    ~/.throne/data/<fork-name>/addendum-<n>-<topic>.md"`. Long relays get
    clipped in delivery; the file is the authority, the message is a pointer.
a3. CONFIRM it landed before telling the Lord the fork has it. The fork's
    identity tells it to answer with one line naming the file; if none comes,
    read its pane (`herdr pane read <pane>`). On 2026-09-21 a parent told the
    Lord six times that its fork "had" rulings the fork had never opened.
a4. An addendum may not order `add-to-queue` or another fork. The fork
    refuses those and reports them, as it would from the brief.

The fork trusts this channel because its identity says so
(`forkedStagerAddendumInstruction` in
`src/agentdata/identity-data.service.ts`): an addendum is a file in the
fork's OWN data directory, announced by its parent. Before that paragraph
existed, a fork treated every mid-task relay as forged, because a message
delivered while a command runs is shown beside that command's output, and
built only its original brief. If a fork still refuses, the Lord saying
"the addenda are genuine" in the fork's pane settles it.

## What it refuses

`--fork-of` registers and launches nothing, and names which condition
failed, unless every one of these holds:

- The role is `Stager`.
- The supervisor is that same parent.
- The parent is live in the roster with ledger role `Stager`.
- The composed `--name` begins `<parent>-`.
- The parent has already written the fork's brief — without one it refuses,
  names that a fork inherits no conversation, and points at the
  `brief.md` path and `lint-queue-plan --body-file`.
- `--cwd` does not point at the parent's own worktree — that trips the
  existing borrowed-worktree refusal.

## Model resolution

The model is `--model` when given, otherwise the parent's live observed
model (`src/session/live-claude-model.ts`), otherwise the parent's ledger
model — one stderr line names which of the three was used.

## Powers

A fork holds full Stager powers, but they answer to the Lord, never to the
brief: it may not file a queue row or fork again on the parent's say-so.
Never write a brief that orders either — it will be refused and reported to
the Lord.

## When to fork, when not to

Fork when the task is long-running and the Lord wants to keep talking to the
current Stager while it runs — the fork carries the task, the parent stays
free. Do not fork for something the parent can finish in the current turn;
just do it directly (`/no-alpha`). Do not fork to dodge a scope confirmation
— the confirmation still applies. Do not fork by reaching for the harness's
own subagent mechanism — see the distinction above.

## Worked example

```bash
mkdir -p ~/.throne/data/stager-tenth-prmedia
cat > ~/.throne/data/stager-tenth-prmedia/brief.md <<'EOF'
INTENT: publish the PR 214 screenshots and video.
SCOPE: repo widget-store, PR 214, media capture and publish only.
RULINGS: none beyond the standing pr-media contract.
VERIFIED-NOUNS: .claude/skills/pr-media/SKILL.md, PR 214.
EOF
throne lint-queue-plan --body-file ~/.throne/data/stager-tenth-prmedia/brief.md
spawn-git-tree stager-tenth-prmedia --repo widget-store --non-campaign
create-agent --fork-of stager-tenth --role Stager --supervisor stager-tenth \
  --name stager-tenth-prmedia --cwd <the worktree spawn-git-tree printed> \
  --non-campaign
```
