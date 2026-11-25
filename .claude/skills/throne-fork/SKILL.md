---
name: throne-fork
description: 'This throne-only, Stager-only skill documents `throne topic changed <slug>`, the one command that hands a prompt whose topic changed to a live or newly forked ordinary Stager, never a harness subagent. Use it when the prompt hook''s topic order finds the topic changed. Only a registered Stager may run it; the Regent cannot fork itself.'
version: 3.0.0
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

A fork happens inside one command. When the prompt hook's topic order finds
the topic changed, run `throne topic changed <slug>`, with
`--brief "<what this conversation settled on that topic>"` only when this
conversation already settled something there, and run nothing before it.
There is no other fork: `create-agent --topic-from` refuses unless your
latest topic record is a change.

## The procedure

Only a Stager may take this path; the Regent cannot fork itself. Ask the Lord
nothing and research nothing: the prompt that changed the topic is the new
Stager's scope, and the new Stager does the research.

1. Run `throne topic changed <slug> [--brief "..."]`.
2. Tell the Lord in one line the Stager's name and pane the command printed.
   Do nothing else, and do not follow it into the task.

When a step fails the command names that step and exits non-zero, and the
verdict stays recorded. Report the failed step to the Lord in one line.

## What the command does

After it appends the verdict, the command names the Stager `stager-<slug>`,
trimmed so the whole name fits 32 characters. When a live Stager of that name
exists it relays the prompt verbatim to it, the way `send-agent` does, and
forks nothing. Otherwise:

f1. It writes `~/.throne/data/<fork-name>/brief.md` in the five-marker shape
    (INTENT, SCOPE, RULINGS, VERIFIED-NOUNS, REUSE): INTENT quotes the prompt
    that changed the topic, RULINGS holds the `--brief` text or "nothing
    settled", and the other markers hold fixed text. THE FORKED PANE INHERITS
    NONE OF THIS CONVERSATION, so what `--brief` leaves out is lost.
f2. It prepares the fork's worktree in the throne repository the way
    `spawn-git-tree <fork-name> --non-campaign` does.
f3. It launches the fork through the `create-agent --topic-from <your-name>
    --role Stager --supervisor Regent --non-campaign` path, which copies the
    prompt that changed the topic, verbatim, from your session transcript into
    `~/.throne/data/<fork-name>/lord-prompt.md`; no agent writes that file.

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
throne topic changed prmedia --brief "PR 214 only; the video is already recorded"
```

It prints the Stager's name and pane, and the reply to the Lord is one line
naming them.
