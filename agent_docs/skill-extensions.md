# Operator extensions to throne skills

The throne is published, so nothing private may live in `.claude/skills`: no
employer tool, no review bot, no host. An operator who wants a skill to do one
more thing on their own machine writes an extension instead. It is a Markdown
file outside the repository that the skill reads and obeys every time it runs.

## Where the file lives

- The folder is `<throne home>/skill-extensions/`, which is
  `~/.throne/skill-extensions/` by default. The throne home comes from the
  throne-home resolver (`resolveThroneHome` in
  `src/shared-policy/throne-home.ts`, which honours `THRONE_DATA_HOME`),
  so setting `THRONE_DATA_HOME` moves the folder with the rest of the throne
  home. No code spells `~/.throne` for it, and there is no `~/.config/throne`
  or XDG lookup.
- The file is named for the skill: `<skill-name>.md`, where `<skill-name>` is
  the skill's folder name under `.claude/skills` (its frontmatter `name`). An
  alias skill reads its own name; the skill it forwards to reads its own, so
  one file for the canonical skill covers both.
- A name that is not a single plain path segment (it holds a `/` or is `..`)
  is refused, so a lookup never reads outside the folder.

## What an extension may do

An extension adds steps to its skill or overrides it. Where the two conflict,
the extension wins, because it is the operator's word.

It cannot lift the court's hard rules (AGENTS.md "Hard rules of the court").
When an extension tries, the skill refuses that part, says which part, and
follows the rest.

An invented example. A bakery ships an `order-cake` skill. Its operator writes
`~/.throne/skill-extensions/order-cake.md`:

```markdown
Before you confirm the order, run the bakery review tool on the order sheet
and fix every finding it marks as blocking.

Then run `npm run test:heavy` before every order, so the oven is proven.
```

The first paragraph is a step the skill does not have, and the agent runs it.
The second asks for the heavy tests, which the hard rules allow only on the
Lord's direct order; the agent refuses that paragraph, says so, and carries on
with the first.

## How a skill picks it up

Every shipped skill opens with the same step, as the first block after its
frontmatter, with `<name>` replaced by the skill's own name:

```markdown
**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension <name>` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.
```

The wording is identical in every skill. A test reads every tracked SKILL.md
under `.claude/skills` and fails when one lacks the step or names a skill other
than its own. A new skill must carry the step from its first commit.

## The command

- `throne skill-extension <skill-name>` prints one line naming the file's path,
  then the file's content verbatim. With no file it prints nothing and exits 0.
  A name that is not a plain path segment is refused with a non-zero exit and a
  one-line reason.
- `throne skill-extension --list` prints one line per extension present, sorted
  by skill name, with the skill name and the path. With none it prints nothing
  and exits 0.

The command, `--list` and the hook below all go through the one resolver; none
of them knows the folder on its own.

## The Claude Code hook, an extra path

In Claude Code inside a throne checkout, a hook in `.claude/settings.json` also
hands the extension over when a skill loads, so the agent sees it even if it
skims the opening step. It finds the throne CLI the way the SessionStart hook
does, passes the hook event's input to the command, and adds the same text the
command prints as the event's `additionalContext`. It is silent when there is
no extension and never blocks the tool call or the prompt.

Two events can load a skill: the Skill tool, when the model loads a skill
itself, and a typed `/skill-name` command, which bypasses the Skill tool and
fires `UserPromptExpansion` instead. The hook is registered only for events
proven live to carry context into the agent. The in-skill step is the
dependable path; the hook is extra.

Codex and OpenCode have no hook on loading a skill. For them the in-skill step
is the only path.

## Extensions never ship

Extensions live in the throne home, outside the repository. They are never
committed, `git` never sees them, and the publish step never reads them. Do not
move one into `.claude/skills`: a step that names a private tool belongs in the
operator's extension, and the published skill stays general.
