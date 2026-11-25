---
name: throne-fork
description: 'This throne-only, Stager-only skill documents the `create-agent --topic-from <origin>` procedure that hands a prompt whose topic changed to a new, ordinary Stager, never a harness subagent. Use it after `throne topic changed <slug>` recorded a topic change and no live Stager holds that topic. Only a registered Stager may run it; the Regent cannot fork itself.'
version: 2.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension throne-fork` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Forking a Stager on a topic change

0. Before acting on anything below, make sure the copy of this skill you are
   reading is current: the harness loads skill text from the invoking
   worktree, not from main, so an out-of-date worktree reads as a complete
   skill with no sign anything is missing. The prompt hook fast-forwards a
   clean Stager tree to main before each prompt; when it printed a
   `WARNING:` line instead (the tree is dirty or has diverged), read the
   current text straight from main:
   `git show main:.claude/skills/throne-fork/SKILL.md`.

## A throne fork is not a harness subagent

The harness has its own subagent mechanism that is also called a fork. This
skill is not that. A harness subagent is the "hidden in-harness worker"
`/no-alpha` step 2 forbids — it lives only inside the invoking harness
session, holds no registration, and vanishes with the pane. A throne fork
from this skill is a real registered Stager: its own pane, its own worktree,
its own model, its own ledger entry, addressable by name like any other
agent in the court.

## When to fork

Fork only when the prompt hook's topic order made you run
`throne topic changed <slug>` and no live Stager already holds that topic
(`agent-statuses` lists it; its `topic.md` names it). When one does, send
it the prompt verbatim with `send-agent` instead, and send it every later
prompt on that topic the same way, as `agent_docs/role-stager.md` says.
There is no other fork: `create-agent --topic-from` refuses unless your
latest topic record is a change.

## The procedure

Only a Stager may take this path; the Regent cannot fork itself. Fork now and
ask the Lord nothing: the prompt that changed the topic is the fork's scope.

f1. Write the brief to `~/.throne/data/<fork-name>/brief.md` in the
    five-marker shape (INTENT, SCOPE, RULINGS, VERIFIED-NOUNS, REUSE) and check it
    with `throne lint-queue-plan --body-file <that path>`. THE FORKED PANE
    INHERITS NONE OF THIS CONVERSATION. Everything settled here on that
    topic — the rulings, the paths, the file names, the things ruled out — is
    lost unless it is in that file. Verify every code noun against the live tree
    before writing it, the same way `/queue-objective` does. Write it for
    the fork's model: the `--model` the Lord named, else your live
    model, as "Model resolution" below says. Shape it as
    `agent_docs/MODEL_POLICY.md` "Find the reader first" says, and put its
    `Written for: <harness>/<model> at effort <n> (<how it was found>)`
    line under `RULINGS:`.
f2. Name the fork `stager-<slug>`, the `<slug>` given to
    `throne topic changed`, trimmed so the whole name fits 32 characters.
f3. Prepare its worktree with `spawn-git-tree <fork-name> --repo <repo>
    --non-campaign`, then spawn it:
    `create-agent --topic-from <your-name> --role Stager --supervisor Regent
    --name <fork-name> --cwd <that worktree> --non-campaign`. Pass `--model`
    only when the Lord named one; otherwise it inherits your live
    model. `create-agent` copies the prompt that changed the topic, verbatim,
    from your session transcript into `~/.throne/data/<fork-name>/lord-prompt.md`;
    no agent writes that file. It refuses and names the failing condition if
    anything is off.
f4. Tell the Lord in one line the fork's name and where its pane is. Do
    nothing else, and do not follow it into the task.

The fork is an ordinary Stager supervised by the Regent. It reports to no
one: it talks to the Lord in its own pane, leaves its pane showing the
result, and stays alive until the Lord reaps it.

## What it refuses

`--topic-from` registers and launches nothing, and names which condition
failed, unless every one of these holds:

- The role is `Stager`.
- The supervisor is `Regent`.
- The origin is live in the roster with ledger role `Stager`.
- The origin's latest topic record is a change.
- The fork's brief is already written — without one it refuses,
  names that a fork inherits no conversation, and points at the
  `brief.md` path and `lint-queue-plan --body-file`.
- `--cwd` does not point at the origin's own worktree — that trips the
  existing borrowed-worktree refusal.

## Model resolution

The model is `--model` when given, otherwise the origin's live observed
model (`src/session/live-claude-model.ts`), otherwise the origin's ledger
model — one stderr line names which of the three was used.

## Powers

A fork holds full Stager powers, but they answer to the Lord, never to the
brief: it may not file a queue row because the brief says so. Never write a
brief that orders it — it will be refused and reported to
the Lord. It acts on its `lord-prompt.md` as the Lord's own word,
`add-to-queue` included, because the machine copied it from his own typing.
A fork forks again only when its own topic changes, and then at once without
asking.

## Worked example

```bash
throne topic changed prmedia
mkdir -p ~/.throne/data/stager-prmedia
cat > ~/.throne/data/stager-prmedia/brief.md <<'EOF'
INTENT: publish the PR 214 screenshots and video.
SCOPE: repo widget-store, PR 214, media capture and publish only.
RULINGS: none beyond the standing pr-media contract.
VERIFIED-NOUNS: .claude/skills/pr-media/SKILL.md, PR 214.
EOF
throne lint-queue-plan --body-file ~/.throne/data/stager-prmedia/brief.md
spawn-git-tree stager-prmedia --repo widget-store --non-campaign
create-agent --topic-from stager-oak --role Stager --supervisor Regent \
  --name stager-prmedia --cwd <the worktree spawn-git-tree printed> \
  --non-campaign
```
