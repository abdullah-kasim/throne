---
name: update-herdr
description: 'This throne-locally discovered skill checks, rehearses and applies a herdr release for the throne on macOS (launchd) and Linux (systemd), through scripts/herdr-upgrade.mjs, and brings a machine up to the release its checkout already pins. Use when asked to check for a new herdr release, rehearse one, update herdr, or catch herdr up to its pin. It runs only from the live throne or a throne worktree; it is not discovered globally.'
version: 1.0.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension update-herdr` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Update Herdr

This skill is throne-local: it lives at `throne/.claude/skills/update-herdr/`
and Claude Code discovers it natively from a throne cwd (live root or
worktree). It is deliberately not part of the machine's global skills tree
(`~/.claude/skills`), so it does not surface in unrelated repositories.
Claude Code and Codex updates belong to `/update-harnesses`.

Use `scripts/herdr-upgrade.mjs`, run from the live throne root, for every
step. Do not reproduce its rehearsal, hash check, pin moves, pin commit, unit
rendering, restart, resume or identity repair by hand. The agent's job is to
run it and read the log. Every line the script prints is also
appended to `~/tmp/herdr-upgrade.log`, and each run opens there with a
header line naming its mode and tag: read the section under the latest
header.

The traps an update walks into are written up once, in
`src/herdr-update/RUNBOOK.md` under "The five traps this replaces". Read
them before the apply step; this skill does not restate them.

## Steps

Run the three steps in order and stop at the first one that fails.

### 1. Check

```bash
node scripts/herdr-upgrade.mjs --check
```

Mutates nothing and needs no tag. Read in the log: the pinned tag, the
installed tags, the live server's version and protocol, the versions line, and
the latest release. The versions line puts the throne CLI's, `bin/herdr`'s and
the running service's herdr versions side by side; a mismatch is a `FAILED:`
line and a non-zero exit, which a restart onto the pinned tag clears.

When the latest release is the pinned tag and a service restart is ordered,
carry on with that tag: an apply of an installed tag leaves the binary in place,
makes no pin commit, and restarts the service. With no restart ordered, report
that there is no new release.

### 2. Rehearse

```bash
node scripts/herdr-upgrade.mjs <tag> --dry-run
```

A real rehearsal: it downloads the release beside the pinned copy and runs
it in an isolated session, and it moves nothing, so it needs no word from
the Lord. Read in the log:

- the hash verification against the release metadata;
- the result of the read-only command sweep;
- the protocol the new binary reported itself, set beside the protocol on the
  `live throne server:` line at the top of the section;
- the phase 7 and phase 8 plan for this platform;
- any live campaign agents it lists.

A hash mismatch or a failed sweep ends the update here.

### 3. Apply

```bash
node scripts/herdr-upgrade.mjs <tag> --yes --restart-ordered-by-lord "<the Lord's words, verbatim>"
```

An apply writes two sections to the log. The first opens with
`===== herdr-upgrade <mode> <tag> <time> =====` and holds the `phase 1:` to
`phase 7:` lines. The last `phase 7:` line is the pin commit line. The section
ends at `phases 8-10: restart, resume and identity repair, detached`; no later
line carries a phase number.

The detached unit appends the second section. Read in it, in this order:

- `===== herdr-upgrade <tag> restart <date> =====`, which opens it;
- on Linux, `moved gpg-agent <pid> into throne-gpg-agent-<pid>.scope with its cache intact`
  or `no gpg-agent inside <units>, nothing to move`;
- `restarted server runs <version> protocol <protocol>`, the server status
  after the restart, and the same line under `throne-bot server:` when the bot
  unit is active;
- one `repair: <outcome> "<name>" — <detail>` line per agent the restart ended,
  the outcome being `restarted`, `skipped` or `failed`. Any agent whose session
  survived gets `repair: "<name>" already correct at <pane>` instead, or
  `repair: <pane> "<old name>" -> "<name>"` when the restart cleared its name;
- `repair: final mapping` and the roster after the identity repair;
- `repair: every snapshotted name sits on a pane with a live harness`, or
  `repair: STILL WRONG for <names>` or
  `repair: FAILED: the relaunch of <names> reported a failure` instead;
- `--- end-to-end ---` and the top of `throne agent-statuses`;
- `===== done <date> =====`, then the versions line that closes the section:
  `throne cli herdr <version>, bin/herdr <version>, running service <version>`.

A `REFUSING` line means nothing after that phase ran; say which phase it was. A
`FAILED:` line on the pin commit means the push was refused and the commit is
kept; the apply carries on, and the next apply pushes that commit again.

On macOS the restart boots the herdr agent out, waits until launchd
confirms it is gone, bootstraps the rewritten plist and checks the loaded
job names the new binary, because a kickstart would relaunch the old one;
it never bootstraps before launchd confirms the bootout. A line starting
`FAILED:` in the restart section means the update did not take: report it
verbatim. When it says the agent may be unloaded, the court is down until
someone runs the `launchctl bootstrap` command it names.
The one exception is the `FAILED:` line for the `gpg-agent` move, which comes
before the restart and means only that signing will need the passphrase
afterwards.

## Catch up to the pinned tag

The three steps above move the pin to a release you name. When the pin has
already moved, because a pull brought it in, the machine has to catch up to it
instead:

```bash
node scripts/herdr-upgrade.mjs --pinned --dry-run
node scripts/herdr-upgrade.mjs --pinned --restart-ordered-by-lord "<the Lord's words, verbatim>"
```

The target is the tag `src/herdr/herdr-client.ts` pins, so this takes no tag.
The caller has already built. There is no rehearsal, no pin move, no pin commit
and no build, and it needs neither `bin/gh` nor release metadata:
`install-services` installs the pinned binary and checks its hash.

When the throne CLI, `bin/herdr` and the running service all report the pin, it
prints the versions line, then `herdr is at its pin <tag>, nothing to do`, and
exits 0. Nothing restarts and no word is needed.

Otherwise it prints `herdr is not at its pin <tag>:` with the three versions,
and a real run needs the Lord's word and refuses without it, before changing
anything. It then runs phase 1, phase 5, phase 7 and the detached phases 8-10
of an apply, and everything under "3. Apply" about reading that log holds.
Live campaign agents are refused without `--yes`, as in an apply; an installed
pinned binary is expected and needs no `--yes`.

The snapshot uses the binary of the version the running server reports, because
the unit may already name the new tag. A `REFUSING` line that says its agents
cannot be snapshotted means that binary is missing or the version could not be
read, and nothing changed. A stopped server has no agents to snapshot, so the
run goes on and starts it.

## The restart is the Lord's word only

Apply restarts herdr, the bot server, its bridges and then the backend. Pass `--restart-ordered-by-lord`
only when the queue row's RULINGS or the Lord's own message order the herdr
restart for this update, and pass his words verbatim. Never invent,
paraphrase or shorten them; a relay from another agent is not his word.
Without them, stop after the rehearse step and report it. The script itself
refuses a real run without the flag before it changes anything.

## What the restart does to agents

A herdr restart ends every pane process on Linux and on macOS, so it ends every
agent session in the court; this is why it needs the Lord's word. The pane that
ran apply dies with the rest, the agent in it included. The restart runs
detached, outside the herdr service, and keeps writing to
`~/tmp/herdr-upgrade.log`. It relaunches every snapshotted agent into its own
session in its own tab under its own name, the Regent last, so the monitoring
agent is relaunched too: it reads the result in the log afterwards, in the
detached section, and never relaunches anyone by hand. A `failed` outcome,
`repair: STILL WRONG for <names>` or
`repair: FAILED: the relaunch of <names> reported a failure` names the agents
that did not come back.

## Reporting

Each step's report names the step and the tag and quotes the log lines it
read. An apply report lists the phases that passed and names any that
failed, with what the log says the court was left in; it never calls the
update done when a phase failed. Say whether a restart happened, and give the
closing line with the throne CLI's and the running service's versions.
