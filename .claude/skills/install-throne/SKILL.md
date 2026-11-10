---
name: install-throne
description: 'This throne-locally discovered skill guides an agent through installing throne on macOS or Linux, and is safe to re-run on a machine where throne is already installed: it changes nothing that is already right and repairs a broken install through the same idempotent installers. It asks once whether to install Forgejo too, installs any missing Podman, Docker compatibility and Docker CLI through scripts/install-container-prerequisites.sh, runs ./install.sh (and ./install-forgejo.sh on a yes) until clean, and finishes only when the herdr service runs and the Regent and a Stager are live. Invoked by /install-throne or /reinstall-throne, or when asked to "install throne", "reinstall throne", "repair the throne install", "fix my throne install" or "set throne up after an update".'
version: 1.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension install-throne` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Install Throne

Run every step from the throne checkout. The installers do the work; the
agent runs them, asks the one question, reads what they print, fixes the
machine and runs them again. Never edit `install.sh`, `install-forgejo.sh` or
`scripts/install-container-prerequisites.sh` to get past a failure.

Every installer here is idempotent, so this skill is also the way to repair or
re-apply an install: on a machine that already runs throne it changes nothing
that is right, and re-running the installers puts back a missing service,
hook, timer, link or prerequisite.

## Steps

Run them in order.

### a. Check

```bash
I_AM_AN_AGENT=1 scripts/install-container-prerequisites.sh --check
```

It changes nothing. Exit 0 ends with `container runtime: ready (<docker|podman>)`.
Exit 1 prints one `missing: <item>` line per item, then
`container runtime: missing`. Exit 2 prints a `needs you:` line naming a
command or fact only the person can supply; tell them that line in plain words
and stop until it is done.

Forgejo is already installed when the file
`${XDG_STATE_HOME:-$HOME/.local/state}/forgejo/enabled` exists; only
`install-forgejo.sh` writes it.

### b. Ask about Forgejo, before installing anything

Skip this question when Forgejo is already installed; the answer is then yes,
and it is never asked again. Otherwise ask the person with the harness's
question tool, in these words or close to them:

> Install Forgejo too, a self-hosted git forge on your tailnet? A yes also
> installs whatever is missing of Podman, Docker compatibility and the Docker
> CLI.

With nobody to answer, the answer is no.

### c. Container runtime

Skip this step when step a printed `container runtime: ready`.

- Yes to Forgejo: run the script without `--check`.
- No to Forgejo: tell the person that `./install.sh` itself needs a container
  runtime for ntfy, its phone notifications, and ask with the question tool
  whether to install Podman, Docker compatibility and the Docker CLI. On a
  yes, run the script. On a second no, stop here and say that the install
  cannot go on without a container runtime.

```bash
I_AM_AN_AGENT=1 scripts/install-container-prerequisites.sh
```

Success ends with `container runtime: ready (<docker|podman>)`. A `needs you:`
line, exit 2, is reported to the person in plain words and the skill stops
until they have done it. Exit 1 after a real run, ending
`container runtime: missing`, means the packages are in place but
`docker info` still fails: it is a failure, not success. Read the `missing:`
lines, find why the engine is unreachable (a stopped Podman machine, an
inactive `podman.socket`, a wrong docker context), fix it and run the script
again. Any other failure: read it, fix the cause, run it again.

### d. Throne

On a machine where throne already runs, tell the person first what
`./install.sh` will start or restart: `install-services` re-installs and
starts the throne services (throne-backend among them) and the agent-browser
and harness steps may move pinned versions; it never restarts a running herdr
and never restarts a live agent. Do not restart herdr, the backend or any
agent yourself; that is the person's call.

```bash
I_AM_AN_AGENT=1 ./install.sh
```

Read each failure, fix the machine, and run it again until it finishes clean.

### e. Forgejo

On a yes in step b only:

```bash
I_AM_AN_AGENT=1 ./install-forgejo.sh
```

Run it the same way as step d. Its own refusals, such as Tailscale not
running or logged in, MagicDNS off, or no git identity, are told to the person
in plain words with what they need to do. Do not set Tailscale up for them.

### f. Completion

Check and show each of these; the skill is not done until all hold:

- the herdr service runs: on Linux `systemctl --user is-active throne-herdr.service`,
  on macOS `launchctl print gui/$(id -u)/com.throne.throne-herdr`;
- `throne agent-statuses` lists the Regent and a Stager as LIVE. When the
  Regent desired-state is `dismissed`, the court stays down on purpose: report
  that as such, not as a failure.

The last message tells the person to quit the agent and run `throne`.
