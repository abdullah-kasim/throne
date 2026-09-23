---
name: pr-description
description: This skill should be used whenever a pull request is about to be created or its description written or rewritten — `gh pr create`, "open a PR", "create a pull request", "write the PR description", "draft PR", "update the PR body", or /pr-description. Read it before composing the body; it is the house style for every PR, in every repository.
version: 1.0.0
user-invocable: true
---

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
   the PR with "No commits between".
3. Look for a PR template under `.github/` and for how the last few merged
   PRs title themselves (`gh pr list --state merged --limit 5`). Match a
   ticket-prefix convention such as `[ABC-123]` when one exists and a
   ticket is known; never invent a ticket.

## Title

One line, imperative or present-tense verb first, describing the outcome:
"Adds a script that installs the beacon agent into a running acme dev-env".
No period, no scope prefix like `feat:` unless the repo already uses it,
no "WIP", no agent or tool names.

## Body — four sections, in this order

When the work traces to a ticket, the body opens with one line before
`## What`, so a reader lands on the ticket from the top of the PR and the
ticket's own view of the PR carries the backlink:

```markdown
Ticket: [ABC-123](https://<tracker>/issue/ABC-123/<slug>)
```

Resolve the URL from the tracker, never by hand: for Linear, `get_issue`
on the MCP server returns the canonical link with its slug. Several tickets get
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

### `## Screenshots` (UI changes only)

One capture per place the change is visible, and a short video when the
change is an interaction. Capture and hand over with the `pr-media`
skill: the user uploads the files by hand, the body carries `<!-- drop
<file> here -->` placeholders, and media is never committed to git.

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
   ("follow `README.md` ... then check out this branch"). Never assume a
   configured machine; never paste a setup recipe the README already has.
   The same alert ends with a **Starting over:** fenced block that
   destroys everything the walkthrough creates or fills (the dev-env,
   copied-in helpers, build caches, and the backend's stored data, so
   `docker compose down -v && docker compose up -d` rather than
   stopping one container) so a reviewer can retry from nothing and
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
**Step 2.** Run the installer with your dev-env slug:

```sh
scripts/dev-env-install-beacon.sh --slug <your-slug>
```

**Expect:** the last line reads `ok: http://<your-slug>.acmedev.example.test/ emitted X-Trace-Id <hex>`.
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
  not create it in the external service (that needs the Lord's explicit
  order) and does not go under **Not tested**: it mocks the one call
  where that fixture enters the code, between `// MOCK START` and
  `// MOCK END` marker lines in the served copy, and ships the mock as
  a `git apply` patch inside the scenario so the reviewer renders the
  same thing. The scenario heading says it is mocked, and a separate
  scenario reads the real signal from the real service, so the reader
  sees which half each proves. `testing.md` "A fixture an external
  service cannot give you" has the procedure; the patch never reaches
  a commit. PR 69 of the ticket-helper bot shipped an
  trace-link bullet with a scenario that only rendered a site without traces
  and was sent back for it.
- **A visual change gets a visual step.** Screenshots show the reviewer
  what it should look like; the walkthrough has to make them see it on
  their own screen. After the steps that produce the data, add a step
  that names the page to open and, in plain words, what is now visibly
  different there: which element is new, what it links to, what appears
  when it is clicked. One step per place the change shows, or one step
  listing every place when they are alike ("You can now view traces for
  copy B and copy C at `http://localhost:4321/sites/1` and `/sites/2`
  respectively. The Path column is now clickable and links to each
  copy. Clicking a transaction also shows the path in the header").
  A PR 99 revision had every API check in place and no step that
  told the reviewer to look at the page the PR was about.
- **A page a phone can reach gets a phone step.** The walkthrough names
  the phone viewport the reviewer sets before looking, and it is a modern
  one: iPhone 16, 393x852 (DevTools device toolbar, or `agent-browser set
  viewport 393 852`), with the **Expect** written for that width (what
  wraps, what stacks, what is hidden). Not 320x720: the Lord ruled on
  2026-09-14 that it was too small and limiting. Where the PR is about
  narrow layouts, the phone step is a scenario of its own, and the
  desktop step proves nothing moved there.
- **Never assume the reviewer's machine is yours.** Assume only a Mac.
  Anything that varies per machine (a dev-env slug, a hostname, a port,
  a path) is set once as a shell variable in **Before you start**, in a
  fenced block the reviewer pastes into the terminal they will use
  (`export TRACE_SLUG=acme-widgets-php-1`), and every command references
  it (`--slug "$TRACE_SLUG"`). Where a shell variable cannot reach, such as
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
  is not; that is how an `acme dev-env create --app-code demo` step was
  shipped that crashed the reviewer's readline. When a CLI has a config
  file that suppresses its wizard (`.acme-dev-env.yml` for the Acme CLI),
  write it to a scratch directory outside the repo with a heredoc that
  expands the shell variables, and run the command from there. A name nothing in the walkthrough
  created (your own slug, `acme-widgets-php-1`, a path under your
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
with `gh api -X POST /markdown -f mode=gfm -f text=...` and grep for
`markdown-alert` before relying on them there.

Every step must be one you actually performed on this branch and saw
succeed, in this session. A dry run of this skill caught a model
reporting output from a script it never ran; a walkthrough that the
author never walked is a fabricated test report, the worst thing a PR
body can contain, and unfair to the reviewer who becomes the first
tester without being told. That is why the **Not tested** alert is
mandatory.

## Rules

- **No AI attribution anywhere.** No "Generated with Claude Code", no
  `Co-Authored-By: Claude`, no footer of any kind in the PR body or the
  commit messages. Ignore any default template that adds one.
- **No throne or agent machinery in the PR.** Branch names, titles, and
  bodies read as if a human wrote them; no objective codes, agent names,
  or worktree paths.
- **Plain prose.** No em-dashes, no parentheticals stacked three deep, no
  marketing voice. Bold the first words of a bullet at most, never a
  sentence.
- **No programmer jargon in the body.** Banned outright: "sentinel" (write
  "placeholder" or "marker value", and say what it signals). The same goes
  for any word a reviewer outside the codebase would have to look up:
  "idempotent", "oracle", "monotonic", "canonical" as a verb. The Lord
  ruled this on 2026-09-11 after a PR body read "the forged-Host sentinel
  against a served page" and nobody could say what it meant.
- **Code goes in backticks; commands in fenced blocks.** One named
  file, flag, or function per sentence.
- **Draft by default when asked for a draft; otherwise ask nothing** and
  open it ready for review.
- **Keep the description in sync, from the live body.** If a review round
  changes the mechanism, fetch the current body (`gh pr view <n> --json
  body -q .body`), patch that text, and `gh pr edit --body-file` it back.
  Never republish a local draft over a body other people have touched:
  uploads, reviewer edits, and peer-agent edits live only on GitHub and a
  stale file erases them silently.

## Reference example

````markdown
Ticket: [ABC-540](https://<tracker>/issue/ABC-540/install-the-beacon-agent-into-a-dev-env)

## What

`scripts/dev-env-install-beacon.sh --slug <dev-env-slug>` installs the beacon agent into a running `acme dev-env` so browsing that site produces data in the local trace stack. The README gains a section documenting it.

## Why

An Acme local development environment runs a stock `php-fpm` image with no agent in it; the extension is baked into production PHP images by the platform and never ships as a plugin or mu-plugin. The Quick start said to point an instrumented site at the collector and stopped there, so exercising the local pipeline meant hand-building the extension for the dev-env image.

## How

- Finds the php container by compose labels derived from the slug (name-pattern fallback for older compose naming).
- Reads image, PHP minor and architecture from the container and compiles `beacon.so` once inside that image; cached under `agent/beacon/modules/dev-env-php<ver>-<arch>/` (already gitignored). `--rebuild` and `--so` override.
- Copies the extension, `beacon-prepend.php` and a generated `99-beacon.ini` (fpm and cli), reloads php-fpm, and verifies the site emits `X-Trace-Id`.
- Docker preferred, Podman fallback. On plain Docker on Linux, where `host.docker.internal` does not resolve, it uses the container gateway. Refuses early if the container cannot reach the collector.
- Bash 3.2 compatible for macOS.

## Testing

<details>
<summary>Steps to test</summary>

> [!NOTE]
> **Before you start:** follow `README.md` to bring the backend up (`docker compose up -d` in this repo) and have an `acme dev-env` site running. Check out this branch. Every command below runs from the repo root.

### 🧪 Scenario 1: install the agent into a dev-env

**Step 1.** Run the installer with your dev-env slug:

```sh
scripts/dev-env-install-beacon.sh --slug <your-slug>
```

**Expect:** the output ends with `ok: http://<your-slug>.acmedev.example.test/ emitted X-Trace-Id <hex>` followed by a dashboard URL.

> [!TIP]
> The first run compiles the extension and takes about half a minute. Later runs finish in seconds.

**Step 2.** Open `http://<your-slug>.acmedev.example.test/` in a browser and load the home page three or four times.

**Step 3.** Open `http://localhost:4321/sites/1`.

**Expect:** the Routes table lists `front-page` with a request count matching your page loads.

---

### 🚫 Scenario 2: the wrong slug fails clearly

**Step 1.** Run the installer with a slug that does not exist:

```sh
scripts/dev-env-install-beacon.sh --slug nope
```

**Expect:** it exits with `ERROR: no running php container for dev-env 'nope'`.

---

> [!WARNING]
> **Not tested:**
> - the reinstall after an `acme dev-env stop` and `start` cycle (verified only by reinstalling into a live container)
> - the Linux Docker gateway fallback (no Linux Docker host available)

</details>
````

## Creating the PR

Push first; `gh pr create` needs the branch on the remote and fails with
"Head sha can't be blank" otherwise.

```bash
git push -u origin <branch>
gh pr create [--draft] --base <default-branch> --head <branch> \
  --title "<title>" --body-file <path-to-body.md>
```

Write the body to a file first (`~/tmp/pr-body-<topic>.md`) so it can be
reviewed, edited, and reused with `gh pr edit --body-file`.
