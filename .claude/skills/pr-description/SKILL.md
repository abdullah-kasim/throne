---
name: pr-description
description: This skill should be used whenever a pull request is about to be created or its description written or rewritten — `gh pr create`, "open a PR", "create a pull request", "write the PR description", "draft PR", "update the PR body", or /pr-description. Read it before composing the body; it is the house style for every PR, in every repository.
version: 1.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension pr-description` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# PR descriptions

A PR body is read by a reviewer who did not watch the work and by someone
running `git log` a year later. Write for both. Everything below is the
house style; project conventions (a `.github/PULL_REQUEST_TEMPLATE*`, a
ticket prefix in titles) layer on top and never replace it.

## Before writing

1. Read the whole branch diff (`git diff <base>...HEAD`), not just the
   files you touched this session.
2. Check the repository's default branch (`gh repo view --json
   defaultBranchRef -q .defaultBranchRef.name`) and target it explicitly
   with `--base`. `main` is a guess, and a wrong guess makes GitHub refuse
   the PR with "No commits between". A PR stacked on another open PR
   targets that PR's branch instead, with `--base <parent-branch>`, and
   its body names the PR it is stacked on and says "merge after
   #<parent>" (`/execute-todos`, "Pull-request delivery"). `throne forge`
   has no default-branch lookup, so this stays `gh` on a Forgejo host too:
   the Forgejo copy is made from `origin` and shares its default branch.
3. Look for a PR template under `.github/` and for how the last few merged
   PRs title themselves (`gh pr list --state merged --limit 5`). Match a
   ticket-prefix convention such as `[ABC-123]` when one exists and a
   ticket is known; never invent a ticket. `throne forge pr list` shows
   only open pull requests, so on a Forgejo host this lookup also stays
   `gh`, against `origin`, where the merged history lives.

## Title

One line, imperative or present-tense verb first, describing the outcome:
"Adds a --dry-run flag to the deploy command".
No period, no scope prefix like `feat:` unless the repo already uses it,
no "WIP", no agent or tool names, and no `[GH-...]` marker: on Forgejo,
`throne forge` adds that itself (see "Creating the PR").

## Body — six sections, in this order

When the work traces to a ticket, the body opens with one line before
`## What`, so a reader lands on the ticket from the top of the PR and the
ticket's own view of the PR carries the backlink:

```markdown
Ticket: [ABC-123](https://<tracker>/issue/ABC-123/<slug>)
```

Resolve the URL from the tracker, never by hand: a tracker's own API or MCP
server can return the canonical link with its slug. Several tickets get
several links on the same line. No ticket means no line; never invent
one, and never write a bare identifier that does not link.

### `## What`

One or two sentences: the user-visible change, naming the entry point
(the command, flag, page, or function a reader would go to). If docs
changed, say so here.

### `## Why`

The gap or failure that existed before, stated as a fact a reader can
verify — what was missing, what broke, what the old docs claimed. This is
the section people search for later. Do not restate What with "because".

### `## How`

A short bulleted list of the mechanism, one idea per bullet: how it finds
things, what it caches and where, which fallbacks exist and when they
fire, what it refuses and with what message, portability constraints
(shell version, OS, runtime). Name the trade-offs you made deliberately.
When the change reads or writes stored data, one bullet says what
happens to rows written before it: whether a schema or migration is
involved, and how missing fields render. Verify it in the code, not
from memory.

### `## Sequence`

Directly after `## How` and before `## Screenshots`. It holds a diagram
of the change's runtime flow, so a reviewer sees who calls whom before
reading the prose.

The section's content is wrapped in a collapsible spoiler that starts
open: `<details open><summary>Sequence diagram</summary>`, a blank line,
the diagram, a blank line, `</details>`. It is the one spoiler in the
body that starts open, and it must: Forgejo 16 draws each Mermaid
diagram into a frame and sets the frame's height once, when the page
loads. Inside a closed spoiler that height is 0, and opening the spoiler
later does not measure it again, so the reader sees the Before and After
labels with empty space under them and no error (seen 2026-10-15 on a
staged pull request: both frames 0px under a closed spoiler, 297px and
295px once the body said `open`; closing and reopening kept them). The reader
can still fold it away. The `## Sequence` heading itself stays outside
the wrapper and unchanged. The other wrapping and blank-line rules are
the ones the `## Agents` section states.

The diagram is a fenced `mermaid` code block holding a
`sequenceDiagram`, written from the code and never from memory: open
each caller and each callee on this branch and copy the names from
there. It is Mermaid because the forge draws it from the Markdown
itself, with nothing to upload.

- **Participants are the things that talk at runtime:** a browser, a
  route, a service, a store, another system. Never files.
- **Every arrow is a real call or message, labelled with its real
  name:** the function, route, event or query a reader can search the
  code for.
- **A change to an existing flow gets two diagrams, before and after,**
  each in its own fenced block inside the one spoiler, under a bold
  **Before** line and a bold **After** line.
- **At most about eight participants and twenty arrows.** Above that,
  split by scenario, one diagram per scenario.
- **No caption that restates the `## How` bullets.** A line above a
  diagram only names its scenario.

**Leave the section out, with no heading and no placeholder,** when the
change has no runtime flow between at least two participants:
documentation, configuration, a rename, a pure refactor that changes no
call, a single function's internals.

Forgejo 16 and github.com draw a Mermaid block inside `<details open>`;
each was seen on a rendered pull request page. Forgejo 16 draws nothing
visible for one inside a closed `<details>` (above). GitHub
Enterprise 3.20 is unverified: one such host's own HTML for an issue
body hands the block to its diagram viewer the way github.com does, but
the drawn diagram was not seen there. `throne forge render-markdown`
does not settle this on GitHub, because the Markdown API answers a
highlighted code block where the pull request page draws the diagram.
Check a new host on a rendered pull request page.

On a host that shows the raw code block instead, render the diagram to
an image for that host and publish it through `/pr-media`, inside the
same spoiler, where the code block would be. PlantUML is the renderer
for that image, used only when it is installed: `plantuml -tsvg`, then
convert the SVG to a PNG for upload.

### `## Screenshots` (UI changes only)

One capture per place the change is visible, and every interaction the
change touches recorded as a video, as the `pr-media` skill's video rule
requires. Capture and hand over with the `pr-media` skill: the user uploads the files by hand, the body carries `<!-- drop
<file> here -->` placeholders, and media is never committed to git.
Every pair's before is the repository's default branch (`trunk`,
`main`), in every round and for a stacked PR too, never a pull request
branch (the `pr-media` skill's before rule); a caption or a sentence above the table that says
otherwise is wrong.

By default the section's content is wrapped in a collapsible spoiler:
`<details><summary>Screenshots</summary>`, a blank line, the captures, a
blank line, `</details>`. The `## Screenshots` heading itself stays
outside the wrapper and unchanged. GitHub only renders markdown inside
an HTML block when blank lines surround it, so both blank lines are
mandatory. `## What`, `## Why` and `## How` are never collapsed.

### `## Testing`

A manual test walkthrough, written for a reviewer who is not an engineer
and did not watch the work. They will follow it literally, so it is
numbered steps, one action per step, grouped into scenarios. The steps
are the deliverable of this section; prose about what you did is not.

By default the section's content is wrapped in a collapsible spoiler:
`<details><summary>Steps to test</summary>`, a blank line, the content
below, a blank line, `</details>`. The `## Testing` heading itself stays
outside the wrapper and unchanged; both blank lines are mandatory for
GitHub to render the markdown inside the block. `## What`, `## Why` and
`## How` are never collapsed.

Layout, top to bottom:

1. A `> [!NOTE]` alert headed **Before you start:** with the environment
   setup, stated generically and deferring to the repo's own docs
   ("follow `README.md` to start the app locally, then check out this
   branch"). Never assume a configured machine; never paste a setup
   recipe the README already has.
   The same alert ends with a **Starting over:** fenced block that
   destroys everything the walkthrough creates or fills (any local
   service started for the walkthrough, copied-in helpers, build caches,
   and stored data, so stopping and restarting the whole local service
   rather than one piece of it) so a reviewer can retry from nothing and
   never reads a previous run's rows as this run's result. It must be safe to paste when none of it
   exists yet: `2>/dev/null || true` on the destroy, `rm -f`, `rm -rf`.
   Run it yourself against a clean state before publishing. The final
   step of the last scenario points back at it instead of repeating a
   partial teardown.
2. One `### <emoji> Scenario N: <what it proves>` heading per scenario,
   separated by `---` rules. Even a single scenario gets the heading.
   Pick an emoji that says what the scenario is (🧪 happy path, 🚫 the
   failure path, 🔁 a loop or watch, 🔌 an API, 🖱️ a UI click-through).
3. Steps inside each scenario, restarting at Step 1 per scenario.
4. A closing `> [!WARNING]` alert headed **Not tested:** with a bulleted
   list, always present, naming every scenario or platform you could not
   exercise and why.

Format of a step, exactly:

````markdown
**Step 2.** Run the deploy command with the dry-run flag:

```sh
scripts/deploy --dry-run --target staging
```

**Expect:** the last line reads `would deploy 3 changed files to staging (no changes applied)`.
````

- **`**Step N.**` in bold**, then one sentence with one action: open a
  URL, click a named button, run one command, open the developer
  console, type a value. The reader scans the bold labels to find their
  place.
- **Commands go in their own fenced block** under the step, one command
  per block, never inline in the sentence, so they copy cleanly.
- **`**Expect:**` on its own line** whenever the step produces something
  the reader should check, with the exact observation. Separating the
  action from the observation is what makes a mismatch obvious.
- **A blank line between steps.** Never a markdown numbered list, which
  renumbers itself and swallows fenced blocks.
- **Key presses as `<kbd>`**: `<kbd>Ctrl</kbd>+<kbd>C</kbd>`.
- **`> [!TIP]` for a hint** that is not a step, such as "the first run
  takes half a minute". Use `> [!IMPORTANT]` for a precondition a step
  silently depends on, `> [!CAUTION]` for anything destructive.
- **Cover the failure path** as its own scenario when the change adds
  one: the wrong slug, the missing header, the 404.
- **A conditional change gets both branches as scenarios: present and
  absent.** When the PR adds something that appears only under a
  condition (a bullet, a link, a column, a header, a flag), one scenario
  renders the real output with the condition met and shows the new
  thing there, and another renders it with the condition unmet and
  shows nothing changed. An absence-only walkthrough proves nothing,
  because unchanged code passes it too. If the present branch needs a
  fixture nobody has (a ticket, a site, a record), the scenario does
  not create it in the external service (that needs an explicit decision
  from the team first) and does not go under **Not tested**: it mocks the
  one call where that fixture enters the code, between `// MOCK START` and
  `// MOCK END` marker lines in the served copy, and ships the mock as
  a `git apply` patch inside the scenario so the reviewer renders the
  same thing. The scenario heading says it is mocked, and a separate
  scenario reads the real signal from the real service, so the reader
  sees which half each proves. A prior PR shipped a status-link bullet
  with a scenario that only rendered a page with the link absent and
  was sent back for it.
- **A visual change gets a visual step.** Screenshots show the reviewer
  what it should look like; the walkthrough has to make them see it on
  their own screen. After the steps that produce the data, add a step
  that names the page to open and, in plain words, what is now visibly
  different there: which element is new, what it links to, what appears
  when it is clicked. One step per place the change shows, or one step
  listing every place when they are alike ("You can now view the status
  for record A and record B at `http://localhost:8080/records/1` and
  `/records/2` respectively. The Status column is now clickable and links
  to each record's history. Clicking an entry also shows its timestamp in
  the header").
  A prior revision had every API check in place and no step that
  told the reviewer to look at the page the PR was about.
- **A page a phone can reach gets a phone step.** The walkthrough names
  the phone viewport the reviewer sets before looking, and it is a modern
  one: iPhone 16, 393x852 (DevTools device toolbar, or `agent-browser set
  viewport 393 852`), with the **Expect** written for that width (what
  wraps, what stacks, what is hidden). A smaller viewport such as
  320x720 is too small to be representative and should be avoided. Where
  the PR is about narrow layouts, the phone step is a scenario of its
  own, and the desktop step proves nothing moved there.
- **Never assume the reviewer's machine is yours.** Assume only the platforms the repository's README supports.
  Anything that varies per machine (an environment name, a hostname, a
  port, a path) is set once as a shell variable in **Before you start**, in a
  fenced block the reviewer pastes into the terminal they will use
  (`export APP_ENV=staging-1`), and every command references
  it (`--env "$APP_ENV"`). Where a shell variable cannot reach, such as
  a URL to open in a browser, a value typed into a UI, or an **Expect**
  line quoting output, spell out the default value the variable was
  given, and say in **Before you start** that those steps assume the
  default. A concrete name may then appear only if an earlier step in
  the same scenario created it: open the scenario by creating what it
  needs, in a form that asks nothing, and close it by tearing that
  down. "Asks nothing" is a claim about a reviewer's terminal, so prove
  it there: run the command yourself with stdin attached to a real TTY.
  A run with stdin from `/dev/null` or through a tool harness lets a
  wizard silently take its defaults and looks non-interactive when it
  is not; that is how a `project init --name demo` step was
  shipped that crashed the reviewer's readline. When a CLI has a config
  file that suppresses its wizard, write it to a scratch directory
  outside the repo with a heredoc that expands the shell variables, and
  run the command from there. A name nothing in the walkthrough
  created (your own environment name, `staging-1`, a path under your
  home, a tool only you installed) must not appear at all. If a step
  depends on a helper that only exists on another open PR, add a
  `> [!IMPORTANT]` saying so and a step that copies the file in without
  touching the reviewer's branch or index (`git fetch origin <branch> &&
  git show origin/<branch>:<path> > <path> && chmod +x <path>`), never
  `git checkout`, and never the hand-rolled sequence the helper
  replaces. Before opening the
  PR, grep the body for your hostname, username, and the names of
  things you did not create in it.
- **Nest a second `<details><summary>` inside the Testing spoiler** when
  one scenario is long and only some reviewers need it. This nests
  inside the outer Testing wrapper above; it does not replace it. Never
  collapse Scenario 1.

A UI feature reads like a click-through. An API-only change reads like a
sequence of `curl` blocks to copy and paste.

GitHub renders `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`
and `> [!CAUTION]` as coloured callout boxes on github.com and on GitHub
Enterprise 3.20 (verified against one such host). Verify a new host
with `throne forge render-markdown --file <path-to-body.md>`, which on
GitHub runs `gh api -X POST /markdown -f mode=gfm -f text=...`, and grep
for `markdown-alert` before relying on them there. Forgejo draws the same
alerts and marks each one `attention-header` instead.

Every step must be one you actually performed on this branch and saw
succeed, in this session. A dry run of this skill caught a model
reporting output from a script it never ran; a walkthrough that the
author never walked is a fabricated test report, the worst thing a PR
body can contain, and unfair to the reviewer who becomes the first
tester without being told. That is why the **Not tested** alert is
mandatory.

### `## Agents`

The last section of the body, after `## Testing`, unless a
`## Ticket Status` section follows it and closes the body. Its reader is an AI
agent that a reviewer asks to "set this PR up so I can try it". Human
reviewers read What, How and Testing; this section is the runbook that
agent follows to stand up an environment where the reviewer can open and
try the change.

The section's content is always wrapped in a collapsible spoiler, so it is
hidden by default: `<details><summary>Agents</summary>`, a blank line, the
steps, a blank line, `</details>`. The `## Agents` heading itself stays
outside the wrapper and unchanged. GitHub only renders markdown inside an
HTML block when blank lines surround it, so both blank lines are
mandatory.

The steps are copy-pasteable and start from the reviewer's existing clone
(a fresh clone works the same) and never change it. Inside the spoiler
they form two procedures under their own sub-headings, `### Spin up` and
`### Spin down`, because the reviewer tests between them: an agent that
ran one sequence end to end would remove the preview before the reviewer
ever opened it.

`### Spin up` holds these steps, in this order, leaving out only a step
that has nothing to do for this change:

1. Fetch the PR head and add a detached worktree for it in a sibling
   folder, then `cd` into it. Every later step runs there. Three fenced
   blocks, run from the reviewer's checkout:
   `export REVIEW_DIR="$(git rev-parse --show-toplevel)-pr-<n>"`, then
   `git fetch origin pull/<n>/head && git worktree add --detach "$REVIEW_DIR" FETCH_HEAD`,
   then `cd "$REVIEW_DIR"`. Detached, so no local branch is created and
   none has to be deleted. Untracked helper files the steps write
   (override files and the like) live in the worktree and go away with
   it. **Expect:** `git status` prints `Not currently on any branch.`
   first.
2. Any other unmerged branch that must be merged locally first, and the
   command that merges it.
3. Dependencies and toolchain versions, and how to install them.
4. The services to start (compose services, databases, stubs) and how
   they get the data the change needs.
5. Environment variables by name, each with where a reviewer obtains its
   value. Never the values.
6. Build, and serve on a free port.
7. The URL to open, and the exact page and state where the change shows.
8. One smoke check that proves it is up: a command and its expected
   output.

Spin up ends with one bold line addressed to the agent, filled in for the
change, so it hands the preview over instead of carrying on:

```markdown
**STOP here. Tell the reviewer the URL to open, the page and state to look at, and that the Spin down section below removes it all. Leave everything running. Do not run Spin down.**
```

`### Spin down` opens with the line "Run this only when the reviewer says they are done testing." Its steps are numbered from 1 again:

1. Find the worktree again from the reviewer's checkout, in a new
   terminal if the one Spin up ran in is gone, and `cd` into it:
   `export REVIEW_DIR="$(git rev-parse --show-toplevel)-pr-<n>"`, then
   `cd "$REVIEW_DIR"`. Spin down relies on no shell variable that only
   Spin up's shell holds, so this step also writes out literally every
   other value Spin up chose: the compose project name, the ports, the
   override files, and any environment variable the stop commands need.
2. Stop and remove what Spin up started, from inside the worktree,
   because the compose files and the like live there.
3. Leave it with `cd "${REVIEW_DIR%-pr-<n>}"`, which is the reviewer's
   checkout, and run `git worktree remove --force "$REVIEW_DIR"`.
   **Expect:** `git worktree list` no longer lists it, and the reviewer's
   own checkout still has the same branch and `git status --short` output
   it had before Spin up's step 1.

Services started for review use their own project name and free ports
(`docker compose -p review-pr-<n>`, and ports nothing else listens on),
because the reviewer's checkout may already run the same stack on the
defaults.

Nothing in Spin up or Spin down switches, creates or deletes a branch in the
reviewer's checkout, the same way a helper from another PR is copied in
without touching the reviewer's branch or index: never `git checkout <default branch>` and never `git branch -D` in the reviewer's checkout.

Spin up's step 3 installs dependencies afresh in the worktree by default.
Package-manager and image-build caches are shared across worktrees, so a
fresh install is usually quick. Add a step that skips the download only
when you measured the install in a fresh worktree and it was slow, and
then write it as a `> [!TIP]` that copies the main checkout's dependency
folder (`node_modules` and the like) with `cp -a`, so symlinks stay
symlinks:

````markdown
> [!TIP]
> To skip downloading the dependencies again, copy them from your own checkout:
>
> ```sh
> cp -a "${REVIEW_DIR%-pr-<n>}/node_modules" .
> ```
````

Each step uses the Testing step format: `**Step N.**`, one fenced command
per block, and `**Expect:**` with the exact observation. A change with
nothing to run (a library, docs, a refactor) says so in one line inside
the spoiler and gives the test command instead, with no sub-headings and
no Spin down, because it sets nothing up.

The steps must work for any colleague's agent on any machine: no
machine-specific paths, usernames, private skill or tool names, internal
hostnames, or secrets, and every rule in "Never assume the reviewer's
machine is yours" applies here too. A local tool that inspired the steps,
such as a script that previews a branch on its own port, is where the
steps come from and is never named: write out the commands it runs.

Run both procedures yourself from a fresh worktree or clone, exactly as
written, and fix the section until they work: run Spin up, check the
change at the page and state it names, then run Spin down, and note that
both worked. Your run leaves your checkout as it found it. Before the PR
exists there is no `pull/<n>/head` to fetch, so your run of Spin up's
step 1 adds the worktree from your branch instead
(`git worktree add --detach "$REVIEW_DIR" <branch>`), with the PR number
you expect in the folder name. Your own run goes straight on to Spin
down, but the written section stays split, because the reviewer's agent
stops after Spin up. A section that was never run is not written.

### `## Ticket Status` (only when the PR differs from its ticket)

When `/ticket-check` reports any DIFFERENT BY RULING line, the PR
deliberately does something other than the ticket asks because someone
ruled that it should, and the body closes with a `## Ticket Status`
section that says so. It is the very bottom of the body, after
`## Agents`; nothing follows it. The `Ticket:` line stays at the top.
Paste `/ticket-check`'s block exactly as it prints it. A PR delivered by
`/execute-todos` finds that block in the todo folder's
`ticket-warning.md`.

```markdown
## Ticket Status

<details>
<summary>⚠️ This PR differs from the ticket in <N> ways</summary>

**This PR differs from the ticket.** Reviewers, check these before approving:

1. **Ticket asks:** "<the ticket's exact words>" — **This PR does:** <what it does instead> — **Why:** <the ruling, quoted, with who and when>.
2. …

</details>
```

- **`<N>` counts the DIFFERENT BY RULING lines.** Write "1 way" when
  there is one.
- **Plain bold text, never a GitHub alert.** No `> [!WARNING]` or any
  other alert syntax anywhere in the section. GitHub Enterprise 3.20
  renders an alert inside `<details>` as a plain quote with a literal
  `[!WARNING]`, so the section uses plain bold text on every host.
- **The blank line after `</summary>` and the one before `</details>` are
  mandatory.** GitHub only renders markdown inside an HTML block when
  blank lines surround it, the same rule as the Screenshots and Agents
  spoilers.
- **One numbered entry per difference, nothing omitted.** Each entry
  gives the ticket's exact words, what the PR does instead, and why: the
  ruling quoted, with who gave it and when.
- **No softening words** such as "slightly", "minor" or "small".
- **No differences, no section.** When `/ticket-check` reports none
  (`no warning needed`), the body has no `## Ticket Status` at all and
  `## Agents` closes it.

## Rules

- **No AI attribution anywhere.** No "Generated with Claude Code", no
  `Co-Authored-By: Claude`, no footer of any kind in the PR body or the
  commit messages. Ignore any default template that adds one.
- **No throne or agent machinery in the PR.** Branch names, titles, and
  bodies read as if a human wrote them; no objective codes, agent names,
  or worktree paths.
- **Plain prose.** No em-dashes, except the separators inside the
  `## Ticket Status` block, which is pasted exactly as `/ticket-check`
  prints it. No parentheticals stacked three deep, no marketing voice. Bold the first words of a bullet at most, never a
  sentence.
- **No programmer jargon in the body.** Banned outright: "sentinel" (write
  "placeholder" or "marker value", and say what it signals). The same goes
  for any word a reviewer outside the codebase would have to look up:
  "idempotent", "oracle", "monotonic", "canonical" as a verb. A PR body
  once read "the forged-Host sentinel against a served page" and nobody
  could say what it meant.
- **Code goes in backticks; commands in fenced blocks.** One named
  file, flag, or function per sentence.
- **Draft by default when asked for a draft; otherwise ask nothing** and
  open it ready for review.
- **Keep the description in sync, from the live body.** If a review round
  changes the mechanism, fetch the current body (`throne forge pr view
  <n> | jq -r .body`, which on GitHub reads the same body as `gh pr view
  <n> --json body -q .body`), patch that text, and `throne forge pr edit
  <n> --body-file` it back (`gh pr edit --body-file` on GitHub).
  Never republish a local draft over a body other people have touched:
  uploads, reviewer edits, and peer-agent edits live only on the forge and
  a stale file erases them silently.

## Reference example

````markdown
Ticket: [ABC-540](https://issues.example.test/browse/ABC-540)

## What

`scripts/deploy --dry-run` prints the files a deploy would change without applying them, so a reviewer can check a deploy's scope before running it for real. The README gains a section documenting the flag.

## Why

`scripts/deploy` always applied its changes immediately; there was no way to preview what a deploy would touch before committing to it. Anyone who wanted to check a deploy's scope first had to read the diff by hand or run it against a throwaway environment.

## How

- Reads the same manifest the real deploy reads and diffs it against the target environment's current state.
- Prints each file that would change, added, or removed, with a summary count, then exits without writing anything.
- Reuses the existing manifest-validation and target-resolution code paths so a dry run and a real run agree on scope.
- Refuses early with a clear message when the target environment does not exist or credentials are missing, the same as a real deploy would.

## Sequence

<details open>
<summary>Sequence diagram</summary>

```mermaid
sequenceDiagram
    participant Operator
    participant Deploy as Deploy command
    participant Manifest as Manifest store
    participant Staging as Staging environment
    Operator->>Deploy: scripts/deploy --dry-run --target staging
    Deploy->>Manifest: readManifest()
    Manifest-->>Deploy: manifest
    Deploy->>Staging: fetchCurrentState("staging")
    Staging-->>Deploy: current state
    Deploy-->>Operator: would deploy 3 changed files to staging (no changes applied)
```

</details>

## Testing

<details>
<summary>Steps to test</summary>

> [!NOTE]
> **Before you start:** follow `README.md` to start the app locally, then check out this branch. Every command below runs from the repo root.
>
> **Starting over:** `scripts/deploy --reset --target staging 2>/dev/null || true` clears any state a prior run left in the staging target.

### 🧪 Scenario 1: dry run reports scope without applying it

**Step 1.** Run the deploy command with the dry-run flag:

```sh
scripts/deploy --dry-run --target staging
```

**Expect:** the last line reads `would deploy 3 changed files to staging (no changes applied)`.

> [!TIP]
> The manifest diff takes a few seconds the first time it runs; later runs are cached.

**Step 2.** Run `scripts/deploy --target staging` without `--dry-run` and confirm it applies exactly the 3 files the dry run listed.

**Expect:** the command reports `deployed 3 files to staging`, matching the dry run's file list.

---

### 🚫 Scenario 2: a missing target fails clearly

**Step 1.** Run the dry run against a target that does not exist:

```sh
scripts/deploy --dry-run --target nope
```

**Expect:** it exits with `ERROR: no environment named 'nope'` and applies nothing.

---

> [!WARNING]
> **Not tested:**
> - a deploy manifest larger than 500 files (no environment with a manifest that size available)
> - the production target (dry run only exercised against staging)

</details>

## Agents

<details>
<summary>Agents</summary>

Nothing to serve: the change is a command run from the repo root.

### Spin up

**Step 1.** From your existing clone of the repository, add a worktree for this PR in a sibling folder and move into it. Every later step runs there, and your own checkout is never changed:

```sh
export REVIEW_DIR="$(git rev-parse --show-toplevel)-pr-87"
```

```sh
git fetch origin pull/87/head && git worktree add --detach "$REVIEW_DIR" FETCH_HEAD
```

```sh
cd "$REVIEW_DIR"
```

**Expect:** `git status` prints `Not currently on any branch.` first, and `git log -1 --format=%s` prints `Add a --dry-run flag to scripts/deploy`.

**Step 2.** Install the pinned toolchain and dependencies:

```sh
scripts/bootstrap
```

**Expect:** the last line reads `bootstrap complete`.

**Step 3.** Ask a maintainer for a staging deploy token from the project's CI settings, then set it:

```sh
export DEPLOY_TOKEN=<staging deploy token>
```

**Step 4.** Prove the change is in place with a dry run:

```sh
scripts/deploy --dry-run --target staging
```

**Expect:** the last line reads `would deploy 3 changed files to staging (no changes applied)`.

**STOP here. Tell the reviewer to try `scripts/deploy --dry-run --target staging` from the `-pr-87` folder, and that the Spin down section below removes it all. Leave everything running. Do not run Spin down.**

### Spin down

Run this only when the reviewer says they are done testing.

**Step 1.** From your existing clone, in a new terminal if the earlier one is gone, find the worktree again, move into it and set the staging deploy token again:

```sh
export REVIEW_DIR="$(git rev-parse --show-toplevel)-pr-87"
```

```sh
cd "$REVIEW_DIR"
```

```sh
export DEPLOY_TOKEN=<staging deploy token>
```

**Step 2.** Clear anything the testing left in the staging target, still from inside the worktree:

```sh
scripts/deploy --reset --target staging 2>/dev/null || true
```

**Step 3.** Leave the worktree and remove it:

```sh
cd "${REVIEW_DIR%-pr-87}"
```

```sh
git worktree remove --force "$REVIEW_DIR"
```

**Expect:** `git worktree list` no longer lists the `-pr-87` folder, and `git branch --show-current` and `git status --short` print what they printed before Spin up's step 1.

</details>

## Ticket Status

<details>
<summary>⚠️ This PR differs from the ticket in 2 ways</summary>

**This PR differs from the ticket.** Reviewers, check these before approving:

1. **Ticket asks:** "Preview every target in one run" — **This PR does:** previews one `--target` per run — **Why:** "One target per run keeps the preview readable; a multi-target preview can follow" (the release lead, ticket comment, 2026-05-12).
2. **Ticket asks:** "Save the preview to a report file" — **This PR does:** prints the preview to the terminal only — **Why:** "Print it; anyone who needs a file can redirect the output" (the ticket author, ticket comment, 2026-05-14).

</details>
````

## Creating the PR

Before pushing, run the `## Agents` steps exactly as written, as that
section requires: set up the review worktree of Spin up's step 1 from your
branch, run Spin up inside it and check the change, then run Spin down to
remove it, leaving your checkout as it was. A section that was never run
is not written.

Create, view, edit and render-check every pull request through `throne
forge`, the throne's one pull-request command (`throne forge status <pull
request>` prints where it lives, and `hostForge` is the forge this host
uses). On a host where Forgejo is installed the pull request opens in
Forgejo, the staging area, and reaches GitHub only when
its owner says so through `/pr-promote`. On any other host `throne forge`
runs the same `gh` command this skill named before, shown beside each step.

Push first; a pull request needs the branch on the remote, and `gh pr
create` fails with "Head sha can't be blank" otherwise. On Forgejo,
`push-branch` first makes the repository's Forgejo copy when it has none.

```bash
throne forge push-branch --branch <branch> --base <base-branch>
throne forge pr create [--draft] --base <base-branch> --head <branch> \
  --title "<title>" --body-file <path-to-body.md>
```

On GitHub these run:

```bash
git push -u origin <branch>
gh pr create [--draft] --base <base-branch> --head <branch> \
  --title "<title>" --body-file <path-to-body.md>
```

Forgejo has no draft flag: a draft is a title that starts with `WIP: `,
and `--draft` adds it, so the title you write still never says WIP.

Every Forgejo title also names its GitHub twin, right after any `WIP: `.
`pr create --draft --title "Add the export button"` opens
`WIP: [GH-##] Add the export button`, `[GH-##]` meaning no GitHub twin yet;
`throne forge stage` and `/pr-promote` put the GitHub number there instead,
`WIP: [GH-123] Add the export button`. Never write the marker yourself, and
GitHub never shows it.

Write the body to a file first (`~/tmp/pr-body-<topic>.md`) so it can be
reviewed, edited, and reused with `throne forge pr edit <n> --body-file`
(`gh pr edit --body-file` on GitHub).
