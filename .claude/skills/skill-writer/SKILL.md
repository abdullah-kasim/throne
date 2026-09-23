---
name: skill-writer
description: Write, create, edit, port, move, copy, share, or "bring over" a SKILL.md file — under this throne's own .claude/skills, a global ~/.claude/skills or ~/.agents/skills tree, a dotfiles skills tree, or any other project's skills directory. Use whenever a skill is being authored or relocated, in this throne or anywhere else, so the result is generalized and scrubbed before it ships.
---

# Writing and moving skills

A skill file outlives the session that wrote it and is often read by someone
with none of that session's context. Before any `SKILL.md` write, edit,
port, move, copy, or share is considered finished, work through the five
decisions below in order.

## 1. Audience decision

Where the skill lands decides how strict the rest of this procedure must
be, never whether it applies:

- A skill shipped under this throne's own `.claude/skills/` is public: it
  ships in a repository intended for public release.
- A global skill under a dotfiles skills tree or `~/.claude/skills` is
  shared with anyone who pulls those dotfiles.
- A project skill under a project's own `.claude/skills/` belongs to that
  project and travels with it.

All three audiences still get generalized and scrubbed. Only the paranoia
level changes: a throne-public skill gets the full treatment below with no
exceptions; a project skill may keep that one project's own real file and
command names.

## 2. Generalize decision

Every example, path, name, host, ticket, product, colleague, customer,
team, codename, and workflow step that only makes sense in one company or
one project gets replaced by an invented stand-in that keeps the taught
shape and changes the domain. The shape is what teaches; the domain is what
leaks.

The one exception: when a skill is genuinely specific to the project it
ships in — it describes that project's own tooling, scripts, or commands —
it may name that project's own real files and commands. It may never name
another project's files or commands. This skill file itself uses that
carve-out below: `./publish.sh` and `publish-scrub.sed` are this throne's
own real tooling, named because this file teaches how to operate them, not
borrowed from elsewhere.

## 3. Scrub decision

Strip absolute home paths, usernames, machine names, environment variable
values, tokens, and internal URLs. Then run the project's own
generalization and leak-detection gates when they exist, and report the hit
count rather than asserting the result is clean:

- Inside this throne: `./publish.sh --dry-run` against the staged content,
  and grep the content directly against every `# verify:` pattern in
  `publish-scrub.sed`.
- Outside this throne: grep against
  `${THRONE_PRIVATE_REFS:-$HOME/.config/throne/private-refs.txt}` when that
  file exists.

A narrative "looks clean" is not evidence. Print the number of hits; the
number must be zero before the skill ships.

## 3b. Invent every example; never adapt a real one

Anonymizing a real incident is not generalizing it. A function name, a
data type, a file count, the order things broke in, the shape of a stack
of pull requests: each survives renaming and still points at the project
it came from. So every example, worked shape and "picture this" scenario
in a skill is invented from scratch, in a domain unrelated to any project
the author works on (a shop, a recipe app, a theme editor), even when a
real incident is what taught the rule. State the rule the incident taught;
do not retell the incident. Dates and the owner's own rulings may stay;
the project nouns around them may not.

## 4. Rule of doubt

Unsure whether something is general enough to keep as written? Generalize
it. Need an example? Invent one; never start from a real one (see 3b).

## 5. Stranger-read self-check

Read the finished skill once as someone with none of this session's
context — no knowledge of this project's roles, hosts, or history. A
sentence that only makes sense to someone who was in this conversation is
not finished.

## Reuse the existing generalization list

Do not re-derive a second list of what counts as a private detail. The
`/share-stuff` skill already maintains that list (roles, paths, tokens,
employer and colleague names, internal hosts) — point at it by reference
and keep this procedure's own scope to the five decisions above.

## Keeping publish-scrub.sed current

When a generalization or scrub removes a term from a skill shipped under
this throne, append that term, in the same commit, as a new `# verify:
<pattern>` line to `publish-scrub.sed`. Match every casing and the obvious
compound forms, the way the file's existing lines do. Never remove or
loosen an existing `# verify:` line, and never touch the file's `s#...#...#`
rewrite rules — only add a new verify line.

Outside this throne, there is no `publish-scrub.sed` to extend. Instead,
append the removed term to
`${THRONE_PRIVATE_REFS:-$HOME/.config/throne/private-refs.txt}` if that file
exists, or name the exact line that belongs there if it does not.

Prove the appended line actually gates something: run `./publish.sh
--dry-run` against a tree that still contains the old term somewhere and
confirm it refuses, citing the newly appended line as the reason.

## Naming another skill from a throne skill

A throne skill that names another skill, as `/<name>` or as "the <name>
skill", records that dependency in `.claude/skill-dependencies.tsv`: one
line per skill, a tab, then `shipped` when the throne carries it in
`.claude/skills`, or `global` when it must come from the machine's own
skills tree. A test fails on any named skill the file does not record, and
every launch reports a `global` entry the machine does not have. Prefer
shipping a dependency over marking it `global`.

## What this skill is not

A companion `skill-write-guard.py` hook watches every `SKILL.md` write and
reminds or denies with a reason when it spots an unscrubbed term. That hook
runs after the write has already happened — it cannot prevent one. Its
presence is the trigger for running this skill's procedure as a rewrite,
not a gate that blocks the write in the first place. Treat any hook
reminder as an instruction to come back here and finish the five decisions
above, not as proof the file is already safe.
