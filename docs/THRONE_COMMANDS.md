# Throne commands — every public command, one line each

Run a command from a checkout as `./bin/throne-cli <command>`, which uses that
checkout's own build; bare `throne-cli` is the live court, the installed live
checkout. Running either with no command prints the full command surface. The
sections below follow the order the command registry composes its families in,
and each table keeps its family's own order.

## Runtime

| command | what it does |
| --- | --- |
| `assert-herdr` | Refuse to run unless inside a herdr session. |
| `agent-logs` | Print a named agent's recent output. |
| `agent-statuses` | Print a table of every herdr agent and its status. |
| `agent-stats` | Report agent timing statistics over the trailing seven days. |
| `read-payload` | Read one staged payload the throne owns completely, then delete it. |
| `send-agent` | Send one message to a named agent without overwriting a draft already waiting in its input box, then press Enter unless suppressed. |
| `mcq` | Answer or dismiss the interactive prompt held up in a named agent's pane; Regent or Stager only. |
| `send-agent-legacy` | Fallback: deliver a message synchronously through the older path that predates the message queue, independent of `send-agent` and the queue's dispatch loop. |
| `message-status` | Poll a durable message queue row for its delivery state. |
| `cancel-message` | Cancel one scheduled message before delivery begins. |
| `delivery-failures` | List, or acknowledge, the delivery-failure notices a sender has not yet acknowledged. |
| `throne-backend` | Run the long-lived server that hosts keep-going, no-idling and the message queue's dispatch loop as in-process workers. |
| `queue-health` | Prove the message queue is reachable end to end, with one verdict. |
| `verify-delivery-path` | Prove the SQLite delivery path end to end, with one verdict. |
| `verify-alpha-floor-delivery` | Prove that the notifier for a breached Alpha floor delivers end to end under its scheduled sender identity. |
| `alpha-autoscale-tick` | Run one Alpha autoscale sweep inside the backend under the cross-process sweep lock, or in this process with `--local`. |
| `autoscale-now` | Check the queue and spawn now instead of waiting for the five-minute autoscale schedule; an alias of `alpha-autoscale-tick`. |

## Agent orchestration

| command | what it does |
| --- | --- |
| `create-agent` | Spawn a new herdr harness and seed its identity. |
| `create-agent-legacy` | Spawn a new herdr harness through the older model-steering path. |
| `keep-going` | Nudge the live Regent or a named agent. |
| `no-idling` | Sweep Alpha families that are fully idle. |
| `find-untasked-agents` | Flag any live Alpha or Shadow that `create-agent` spawned but `send-agent` never tasked, whether or not its family is fully idle. |
| `usage-rate` | Report the plan-usage burn rate. |
| `derive-shadow-name-from-alpha` | Derive the canonical Shadow name from its supervising Alpha and slice id. |
| `notify-lord` | Send one explicit message to the Lord through the configured ntfy transport. |
| `check-config` | Load and validate `config.user.ts` and print each role's model and effort. |
| `list-harnesses-and-models` | List the active role pools, the launcher policy and the model scores. |
| `switch-agent-model` | Safely resume a registered live agent, exactly where it was, under a different model of the same family. |
| `switch-persona` | Switch, show or list the active roleplay persona preset; switching also syncs the ledger's addressing links for live agents and never renames them. |
| `complete-agent` | Reap a finished agent after verifying its completion signal. |

## Delivery lifecycle

| command | what it does |
| --- | --- |
| `reap-agent` | Tear an agent down; a `--reason` is required. |
| `spawn-git-tree` | Create a git worktree for a coding slice. |
| `merge-git-tree` | Merge a coding worktree's branch back into its target. |
| `make-squash-commit` | Preview, on a scratch ref, the one-commit squash a delivery would land; never touches the candidate or target branch. |
| `lint-slice-assignment` | Exit 1 with a reason when a slice's `ASSIGNMENT.md` is missing its mandatory completion section. |
| `absorb-git-tree` | Absorb a target branch into an Alpha branch and stamp the acting Shadow's own branch, in one atomic step. |
| `verify-delivery` | Verify a named branch's delivery from git state, independent of any report. |
| `validate-delivery` | Check whether a commit is present on a repository's checked-out branch, without consulting the ledger. |
| `check-main-integrity` | Detect a commit that did not come through delivery already landed on a protected branch, cross-checked against the ledger and never trusting the author. Runs on demand only and repairs nothing. |
| `trim-queue` | Archive complete and abandoned items in the Regent queue store; a dry run by default. |

## Queue

| command | what it does |
| --- | --- |
| `add-to-queue` | Add a new open item to the Regent queue store; Stager only. |
| `update-queue` | Correct the editable fields of a Regent queue item, including amending its body or replacing it outright. |
| `amendment` | Record the Lord's amendment on a queue row as a numbered amendment and tell that row's in-flight Alpha and the Regent. Refuses rows already delivered; Stager or Regent only. |
| `check-queue-amendments-reconciled` | Exit 0 when an Alpha's plan records every amendment on its queue row as reconciled, and 66 when one is not; used to refuse pushing and merging past an unread amendment. |
| `situation-brief` | Print the launch situation for a queue row: its recorded amendments, local and remote branch state, other queue work on the same repository, open pull requests and cited commits. Appended to every new Alpha's opening prompt. |
| `lint-queue-plan` | Check a consolidated plan body for the canonical section markers of the Stager checklist before it is filed launch-ready. |
| `mark-queue-launch-eligible` | Mark an open queue objective launch-eligible with complete launch metadata. |
| `reconcile-queue` | Refresh the queue's delivery evidence, or explicitly close work another campaign absorbed. |
| `stage-launch-brief` | Stage, correct or expire an autoscale launch brief the Regent authorized. |
| `migrate-queue-markdown` | Migrate the Regent's `QUEUE.md` and `QUEUE-ARCHIVE.md` content into the SQLite queue store, one way. |
| `install-services` | Install the throne's hooks and services. |
| `ensure-harness-setup` | Re-register the throne's Claude and Codex harness hooks for the live root. |
| `attach-throne-herdr` | Attach to the named throne herdr session. |

## Platform

| command | what it does |
| --- | --- |
| `throne-startup` | Initialize the throne harness and its heartbeat. |
| `dismiss-regent` | Stand the Regent down. |
| `summon-regent` | Bring the Regent back. |
| `restart-harnesses` | Restart every live agent's harness process in place onto the currently vendored binary, resuming each exact native session and keeping its herdr name. Run after the `/update-harnesses` skill. |
| `opencode-go-usage-remaining` | Report the OpenCode Go usage remaining. |
| `plan-usage-remaining` | Report the Claude plan usage remaining. |
| `codex-usage-remaining` | Report the Codex plan usage remaining. |
| `resource-pressure` | Report host capacity pressure: the admission gate's pressure verdict plus load, IO and memory context. |
| `token-balance` | Report the token-lane load balancer's verdict: which lane new balanced-role spawns should use, or why neither is usable. |
| `campaign-evidence` | Generate campaign evidence. |
| `sweep-tmp-scratch` | Sweep aged scratch directories nothing holds; a dry run by default. |
| `git-identity` | Print the git author identity from `config.user.ts` (`identity.name` and `identity.email`); exits 3 when it is unset. |
| `memory-dir` | Print the durable cross-session memory directory for the project containing a directory, deferring to any memory convention already in force. |
| `recall` | Print the recorded memories that apply to a task, most relevant first and capped in size, from the named repositories or memory directories plus the global memories; also serves the prompt-submit hook. |
| `rank` | Rank files or input items by how likely each answers yes to a question, most likely first, so only the top few get opened; never prints item contents. |
| `locate` | Print the files most likely to matter for a stated task, each ranked with a probability and a one-line reason. |
| `sift` | Read command output on standard input, save the full copy under `~/tmp`, and print only the chunks that matter to what you are looking for, with line numbers. |
| `jev-probe` | Ask Jev one yes/no question about one state within the machine's Jev budget, printing the estimated cost first; the only sanctioned way to test a Jev wording. |
| `reclaim-agent-scratchpads` | Reclaim the temporary session scratchpads of dead agents, only those positively attributed to them; a dry run by default. |
| `disable-throne` | Stop the throne's systemd units; messages no agent. |
| `enable-throne` | Start the throne's systemd units; messages no agent. |
| `render-queue` | Render the current state of the SQLite Regent queue store as readable markdown. |
| `consume-fence-handoff-on-start` | Read and clear the current fence handoff record, so a freshly summoned Regent learns why its predecessor was fenced before it handles any pane message. |
| `record-suite-hold` | Record that a campaign now holds full-suite access, so a fenced Regent's successor can learn who was mid-sequence. |
| `record-suite-release` | Record that a campaign has released full-suite access. |
| `read-suite-arbitration` | Print the campaigns currently holding full-suite access. |
| `throne-bot-say` | Post a text message into a bot's Matrix room. |
| `throne-bot-send-file` | Post a file attachment into a bot's Matrix room. |
| `throne-bot-register-bot` | Register a bot's Matrix account and room against the running homeserver. |
| `throne-bot-list-bots` | List the registered bots and their room state. |
| `throne-bot-lint-objective` | Check the body of an objective a bot filed for the mandatory final DONE step. |

For every command's flags, exit codes and detailed behaviour, see [`agent_docs/commands.md`](../agent_docs/commands.md).
