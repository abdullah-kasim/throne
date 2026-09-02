# throne

An agent-agnostic orchestrator: a typed CLI over `herdr` that runs a standing
hierarchy of AI coding agents across any repository. You talk to one agent,
it queues what you want, and the court delivers it.

`AGENTS.md` is the operating law for agents working inside it. This file is
the front door: how to install it, how to use it, and who the agents are.

## Install

Three steps. The throne stands alone: a machine with no `herdr`, no Claude
Code and no Codex on it is the expected starting point.

1. **Clone it** — `~/throne` is the recommended location (the docs, the
   service templates' comments and the worked examples all assume it; any
   path works):

   ```bash
   git clone <this repo> ~/throne
   cd ~/throne
   ```

2. **Start an agent in that folder.** Claude Code is recommended; Codex also
   works:

   ```bash
   claude      # recommended
   codex       # also fine
   ```

3. **Ask the agent to run the installer**, in so many words:

   > Run `./install.sh` and keep going until it finishes clean.

   The installer is run **by an agent, not by hand**: it refuses to start
   without `I_AM_AN_AGENT=1`, which the agent supplies when it runs it. This
   is deliberate — an agent reads whatever breaks on your particular machine
   (a too-old bash, a missing `flock`, a Node below 24), fixes it, and
   re-runs until the install is clean, where a human pasting commands stops
   at the first error. Its last message tells you to quit it and run `throne`.

The script installs the node dependencies, compiles the CLI, downloads all
three harnesses at pinned versions, pulls the ntfy image, installs and
starts every service, and then seats the court: it runs `keep-going`, so a
Regent is live before the installer returns (a `dismissed` desired-state is
honoured), sends a newly raised Regent its install order, and waits for the
Stager that the Regent's startup hook raises — applying the same floor
directly if the hook did not. It is
**idempotent** — re-run it after every `git pull` to apply a moved pin; a
no-op run takes about a second and changes nothing.

Then:

```bash
./bin/claude      # Claude Code in yolo mode, on the throne's pinned binary
./bin/codex       # Codex in yolo mode, on the throne's pinned binary
./bin/throne      # open/attach the throne herdr session
./bin/throne-cli  # the court's command surface
```

Everything downloaded is gitignored and reproducible from the manifests:

| what | where | pinned by |
| --- | --- | --- |
| Claude Code, Codex | `./vendor/` | `vendor-pins.json` |
| herdr | `~/.local/share/throne/herdr/<tag>/` | `src/install-services/herdr-release.service.ts`, with a per-artifact sha256 |
| node deps, compiled CLI | `./node_modules/`, `./dist/` | `package-lock.json` |

herdr sits outside the repo deliberately: campaign worktrees are separate
checkouts that must all resolve the same herdr binary.

Take it back down by asking an agent to run `./uninstall.sh` (add `--purge`
to drop `dist/` and `node_modules/` too; same `I_AM_AN_AGENT=1` contract). Your `config.user.ts`, the `~/.throne/` ledgers, and the
checkout itself are never touched. Note that stopping herdr drops every live
agent pane, so check `./bin/throne-cli agent-statuses` first.

Only two things must already exist: **bash ≥ 4.3** (macOS ships 3.2 — `brew
install bash`) and **Node ≥ 24**. The installer checks both and refuses early
with instructions rather than failing halfway.

## Usage

1. **Open the throne** — run `throne`. This connects you to the herdr
   instance the throne runs on; every agent in the court is a pane in it.

2. **Ask the Stager for anything you want**, in plain words:

   > Repo `/path/to/repo` needs this feature sorted out. Create a PR branch
   > for adding X.

   The Stager is the agent that exists to be talked to. It will ask you
   whatever it needs to pin the plan down.

3. **The Stager queues it up.** It files the consolidated objective as a queue
   row; the autoscaler's dispatcher picks the row up, spawns an Alpha for it,
   and the Alpha runs the campaign in its own worktree through Shadows. You
   do not drive any of that.

4. **Ask the Stager for the queue status** whenever you want to know what is
   done, what is in flight, and what is still waiting.

## The peerage

Work flows down. Escalations flow up one link at a time. No tier below the
Regent holds the whole map.

| Tier | Role | Mandate |
| --- | --- | --- |
| 1 | **Lord** | The human. Wills objectives into being and speaks to the Stager; the tiered court below never asks the Lord a question — it reports outcomes, never decisions to make. |
| — | **Stager** | The Lord's point of contact, standing beside the tiered chain rather than in it. Talks to the Lord directly (the one role whose job is to ask him questions), consolidates his objectives, and files them to the queue; never spawns, never supervises, never takes instructions from anyone but the Lord. |
| 2 | **Regent** | The harness running in the throne itself. Owns the queue, spawns and supervises campaigns, and delegates everything; does no execution work and sends the Stager nothing. |
| 3 | **Alpha** | Spawned by the Regent, one per campaign. Plans, splits, assigns, monitors, and resolves every ambiguity itself. |
| 4 | **Shadow** | Spawned by an Alpha, one per slice. Executes its assigned slice. Routine questions go to its Alpha; genuine blockers go to the Regent. |

Each tier spawns only the tier directly below it (sole sanctioned exception:
the `/gap-analysis-model` skill's launcher Shadows spawn that run's pinned
second-tier campaign Alphas). Every spawned agent is a real
`herdr` harness with its own tab, context, and worktree — addressable by name,
watchable through `agent-logs` — never a subagent nested invisibly inside its
caller.

## License

[MIT](LICENSE).
