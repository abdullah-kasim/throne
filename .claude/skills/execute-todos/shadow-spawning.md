# Spawning a Shadow for a slice

### 2. One worker per todo — a fresh real Shadow every time, never continue


Why this is non-negotiable:

- A continued worker carries its prior context — wrong paths it explored, assumptions it made, drift from the principles file. A fresh spawn starts clean.
- Token costs: a continued worker re-loads its entire prior conversation. A fresh worker only loads what its assignment + its reads bring in. Counterintuitively, fresh-per-todo is cheaper at scale.
- Isolation: if worker N hit a bug or made a questionable call, that bias doesn't infect worker N+1.

Each Shadow:

- Receives a self-contained assignment (it has not seen the conversation) via its `ASSIGNMENT.md` ledger (step 4 below).
- Reads the relevant context files explicitly (see rule 4).
- Executes one todo end-to-end: code + execution log + commit (one commit, not two).
- Reports a brief DONE status (≤200 words) to its supervisor (you) so the orchestrator can pick the next todo.
- When ready to be reaped, tells its supervisor first (the primary, never-dropped
  requirement), then publishes the canonical claim supplied by the generated
  assignment's completion section. Do not duplicate that literal protocol here.

The bullets' worktree, commit, and merge mechanics apply only to `git-repo`.
For `no-git`, the fresh Shadow runs in the generated managed empty workspace,
while the separately named `TARGET_PATH` remains the operational target and
delivery authority. The Shadow makes no Git commit and returns objective-native
evidence plus its ledger execution log.

The orchestrator (you, the Alpha) holds the queue, picks the order, evaluates results, and decides whether to continue / pause / spawn a follow-up. The orchestrator NEVER continues a Shadow's work itself — when the queue advances, that's a fresh spawn.

- **Per slice** (one fresh worker each, scheduled per Rule 3):
  Every campaign Alpha records its contract once at launch with
  `--objective-code <code>`. The code is a lowercase ASCII alphanumeric token in
  the canonical `alpha-<code>-...` handle, and `create-agent` records it in the
  Alpha's identity and spawn evidence. A Shadow inherits that evidence; it never
  receives a hand-copied objective code. Deliberate Alpha or Shadow infrastructure
  outside a campaign must opt out explicitly with `--non-campaign`. The Regent is
  orchestration infrastructure rather than a `create-agent` campaign agent and is
  exempt.

  1. **Derive the full Shadow handle from the live Alpha contract.** The `ALPHA`
     variable above is the current Alpha's canonical handle. For each slice, ask
     the live throne command for the complete descendant handle and keep its exact
     output in one variable:

     ```bash
     slice_id="<slice-id>"
     slice_addr="$(node "$THRONE/dist/src/tools.js" derive-shadow-name-from-alpha "$ALPHA" "$slice_id")" || exit 1
     ```

     The result is the full address (`shadow-<code>-<slice-id>`). Do not construct
     it, copy the code into it, or pass an objective-code flag to a Shadow. The
     command reads the Alpha's durable spawn evidence and refuses contradictory,
     invalid, missing, or unreadable evidence. For a pre-contract Alpha whose
     readable evidence has neither `objective_code` nor `non_campaign`, its
     narrowly scoped compatibility fallback takes only the first canonical token
     after `alpha-`; this fallback never guesses through unreadable evidence. A
     non-campaign Alpha can only have deliberate non-campaign Shadow infrastructure,
     which must pass `--non-campaign` explicitly and therefore has no derived
     campaign handle.

     Use `$slice_addr` for every subsequent step — the worktree, the create-agent
     call, the data path, and all downstream tooling calls. This keeps the exact
     handle returned by the live contract command as the single name source.

     **This name-match is now TOOL-ENFORCED — you cannot silently strand a tree by diverging.** `create-agent` REFUSES (exit 1, nothing spawned or written) when an explicit `--cwd` sits inside a managed worktree whose name differs from the derived agent name, and `reap-agent` exits 1 naming the surviving worktree + `~/.throne/data/<tree>/tree-base.json` instead of falsely reporting success when a mismatched tree's residue would be stranded (a stranded tree also surfaces on the Regent's periodic `checkStrandedTrees` sweep). Using `$slice_addr` for BOTH the tree and the agent, as above, satisfies both guards; passing a bare `<slice-id>` to `spawn-git-tree` while letting the role prefix derive `shadow-<slice-id>` is exactly the divergence they now catch loudly at spawn or teardown — not the silent worktree/branch/`tree-base.json` leak it used to be.

  2. **Git repo: its own worktree; no-git: the operational target** —
     In `no-git`, this is an explicit treeless/read-only campaign path: pass
     `--empty-worktree` and use the generated empty workspace as the
     `create-agent --cwd`; never initialize Git there. The generated
     `AGENTS.md` states that the workspace is not a target checkout or Git
     delivery authority; target mutation/delivery must use its separately
     named repository worktree. In `git-repo`,
     spawn the slice tree against `$CAMPAIGN_REPO` using the derived address:
     ```bash
     repo_flag=(); [ -n "$CAMPAIGN_REPO" ] && repo_flag=(--repo "$CAMPAIGN_REPO")
     node "$THRONE/dist/src/tools.js" spawn-git-tree "$slice_addr" "${repo_flag[@]}"
     ```
     Because `$slice_addr` is shaped `shadow-<code>-…`, `spawn-git-tree` treats
     it as a campaign Shadow: it bases the tree on the supervising **Alpha's
     branch** (the branch named exactly like you — a `createTree` invariant),
     resolving the Alpha from the name's objective code, so the whole campaign
     accumulates on your branch instead of braiding into the target branch. Two
     loud escape hatches exist, neither of which a mid-campaign slice should
     need: `--alpha <name>` pins the supervising Alpha explicitly when
     name-based resolution is ambiguous, and `--non-campaign` forces
     current-branch basing for deliberate infrastructure trees outside any
     campaign. A missing or ambiguous Alpha, a missing Alpha branch, or a
     recorded-repo mismatch refuses BEFORE any write — no worktree, no branch,
     no `tree-base.json` left behind.
     The command prints the tree's inner **project dir** (for an external repo that is that
     repo's project dir, NOT a throne dir); the slice's coding happens there
     (AGENTS.md worktree discipline), never the live checkout. Passing `--repo` is
     what lets `merge-git-tree`/`reap-agent` resolve the SAME target repo later — they
     read each tree's own recorded `tree-base.json` — so cross-repo merge-back and
     teardown follow automatically, with no extra flags on those steps. For a
     campaign Shadow the record also carries `branch` = your Alpha branch: the
     merge target step 6 lands in.
  3. **The Shadow harness/model — resolve it inside the active role pool.**
     Re-read the live `active_plan` at spawn time. Ordinary slices select from
     `rolePools.Shadow`; `99a`, `99b` and `99c` all select from
     `rolePools.ShadowSlice99`. Preserve
     pool order while applying the slice requirement, then quota/availability.
     ```bash
     node "$THRONE/dist/src/tools.js" create-agent \
       --harness <selected in-pool harness> --model <selected in-pool model> \
       --name "$slice_addr" \
       --supervisor <your own herdr name — you are the Alpha> --escalation Regent \
       --role Shadow --cwd <the slice tree's project dir that spawn-git-tree printed>
     ```

     A perceptual bundle's `NNz_critique_<module>` gate DOES carry
     `--deliverable-shape verdict-only` — it is an ordinary-band slice whose
     branch is empty by design, and the name-pattern exemption below covers
     only the `99` terminal gates (see "Rubric critique gates" under
     "Patterns that pay off").
     A ticket-driven bundle's `98_ticket_<topic>` Shadow also carries
     `--deliverable-shape verdict-only`. It is an ordinary-band slice from
     `rolePools.Shadow` that runs after every other ordinary slice has
     landed; it runs `/ticket-check` on the candidate and writes no product
     code, so its branch is empty by design.
     No terminal gate carries `--deliverable-shape verdict-only`: `99b`
     legitimately commits the fixes it makes, and `99c` legitimately commits
     the target absorb. `99a` genuinely produces no diff — it grades and never
     repairs — and a `99b` that found nothing to fix correctly produces none
     either; `merge-git-tree` accepts both no-diff merges on the terminal
     gate's own name shape rather than on a declared deliverable shape. Keep
     the role word in every terminal slice address (`99a-conform-…`,
     `99b-verify-…`, `99c-deliver-…`): classification reads the verb, not the
     letter, because the letters mean different things across bundle
     generations.

     Native Codex needs no extra permission flag. Omit `--effort` on every
     fresh spawn — the engine resolves the model's lowest available effort and
     refuses a divergent explicit score. Request an ordinary slice inside the
     execution-shadow allowed set: any Codex GPT row, or any Anthropic row
     EXCEPT `fable`, which is reserved for Alphas and the 99 gate. The engine
     then applies executable usage/quota routing. It may keep the request or
     remap to any equivalent qualifying pair still admitted by the selected
     pool, including changing model and harness, and records why.
     Usage steering is mandatory, so an explicit in-set request is not
     necessarily exact. Accept and record the admitted final route. Terminal
     slices use the same policy-selected request path. Provider/company
     identity is not a selection axis.

     `--name "$slice_addr"` passes the full handle returned by the live
     derivation command. A REAL Shadow uses that exact value for its herdr tab,
     worktree, ledger, and address, so it appears in `agent-statuses` and is
     watchable via `agent-logs $slice_addr`.
     `--role Shadow` records the role in `data/$slice_addr/identity.md`; the two
     addresses are court law — **supervisor = the spawning Alpha** (routine),
     **escalation = Regent** (blockers only).

     For an ordinary Shadow, quota routing evaluates only the surviving
     `rolePools.Shadow` pairs. `create-agent` first excludes harnesses absent
     from that pool, then may choose the admitted harness with higher
     weekly-remaining headroom and apply the Claude 5-hour reservation floor.
     Every remap must land on an equivalent pair still present in the pool. If
     the requested pair, remap, upgrade, or fallback is excluded, the spawn
     pauses rather than substituting an arbitrary model.

     Every bypass flag means exactly what the "Steering + bypass contract"
     section says and nothing more — none of them touches a role pool. The
     steering decision (active preset, selected role pool, requested and final
     harness/model, effort, and why) is recorded on the `Spawned …` line,
     visible via `agent-logs $slice_addr`; copy that routing evidence into the
     todo's `## Execution log`. `create-agent` owns the final route: accept a
     successful admitted route even when quota or usage steering changes the
     requested model or harness. Record the requested pair, final pair, and
     routing reason in the todo's `## Execution log`. Non-quota divergence
     without the tooling-named narrow bypass remains a refusal —
     `--bypass-model`, Lord-authorized only. A tooling refusal remains
     authoritative.

     `--role Shadow` is also now the ONLY way a slice worker may spawn:
     `create-agent` refuses any non-preset role (`{Alpha, Shadow}` are the
     presets) without `--bypass-preset-agent`, so the generic `--role Agent`
     default is refused here — this convention is tool-enforced, not just
     guidance.

  4. **Deliver the assignment via a file, not inline.** `create-agent`'s opening
     prompt is only the identity sentence — it carries no task. Write the full
     self-contained slice prompt (everything Rule 4 lists, plus the verbatim Rule
     5 / Rule 7 / Rule 8 mandates and the resolved personality + its definition)
     to `"$THRONE_DATA/$slice_addr/ASSIGNMENT.md"` (the durable `data/$slice_addr/ASSIGNMENT.md` ledger), then point the Shadow at it:

     ```bash
     "$THRONE/bin/throne-cli" send-agent "$slice_addr" \
       "Read and execute your assignment at $THRONE_DATA/$slice_addr/ASSIGNMENT.md. Do all coding in your cwd worktree, make exactly one commit, then report DONE to your supervisor via send-agent. Genuine blockers go to Regent."
     ```

     Issue exactly this one ordinary `send-agent` call. Let it derive the
     Alpha's canonical sender name automatically and deliver one
     recipient-visible `<sender-name> said: <prompt>` turn through the shared
     submit engine; do not hand-prefix the text or add a follow-up send/Enter.
     Write the prompt to a FILE, never inline into `send-agent`: real newlines
     inside one quoted argument survive, but separate prompt arguments are
     space-joined and large bodies remain unproven at this seam. A file the
     Shadow reads is the reliable channel for this large assignment.

     **MANDATORY gate before `create-agent`/`send-agent`:** hand-writing the
     Rule 6 completion section into `ASSIGNMENT.md` is no longer sufficient
     — build it with the `src/slice-assignment/slice-assignment-template.ts`
     renderer (or hand-append its fixed marker exactly) and then run `node
node "$THRONE/dist/src/tools.js" lint-slice-assignment
"$THRONE_DATA/$slice_addr/ASSIGNMENT.md"` against the file you just
     wrote. A nonzero exit is a hard stop: fix the assignment file and
     re-lint before spawning. Do not `create-agent`/`send-agent` a Shadow
     whose assignment file fails the lint.

  5. **Wait for completion events (Rule 3).** The Shadow's DONE or blocker
     `send-agent` message is an immediate supervision event and the primary
     wake-up path. When no work is dependency-ready, become idle: schedule no
     sleep, query, or follow-up model turn. Use `agent-logs "$slice_addr"` only
     for one completion review, an explicit blocker, or silence beyond the
     30-minute Regent heartbeat interval. Never use `agent-statuses` as a
     short-cadence substitute. Per-slice verification is the slice's own focused tests
     and mutation checks plus the mechanical checks over its own diff, under
     "Mechanical checks shift left into the slice that creates the defect"
     below; a slice that reports DONE with one of those failing has not
     delivered. The full suite is never a per-slice run — it runs
     baseline-comparative exactly once over the assembled candidate, under
     "Three verification layers, and the layers are not interchangeable"
     below. Whether the
     next slice's Shadow spawns now follows Rule 3's scheduling contract, not
     a blanket wait.
  6. **Merge back into YOUR branch, then reap.** On a verified DONE, merge and
     reap promptly — merges strictly one at a time, teardown never batched.
     In `no-git`, skip merge-back and worktree teardown with the recorded N/A
     reason, verify the requested state plus ambient-state preservation, then
     reap only the Shadow tab/ledger through ordinary throne tooling. In
     `git-repo`,
     Land the slice with `node
`node "$THRONE/dist/src/tools.js" merge-git-tree "$slice_addr" "<slice message>"`: it reads the tree's
recorded `tree-base.json`and merges into the recorded`branch`— your
Alpha branch, never the target branch, and never a silent fallback to
root HEAD. **Transport is flexible; the destination is not:** it lands at
the root checkout when that branch is current there, inside the
registered worktree that has it checked out (normally your own tree), or
via a temporary worktree it creates and removes when the branch is
checked out nowhere — topology inconvenience is never a failure. The one
refusal is fail-closed metadata: an absent/legacy record with no usable`repo`+`branch`refuses because the target cannot be known safely; treat
that as a campaign metadata/process defect and repair the record or the
step that failed to write it — do not guess a branch and do not add
another merge validator. The stash → merge → unstash discipline over a
dirty destination and the conflict-abort semantics are the command's own;
you never need raw git here. **PX2 merge-round tripwire (Lord):** a merge
must land its intended content in one round; at most two rounds, the
second only for a diagnosed fixable cause; a needed third round means you
(the Alpha) merge by hand with plain documented git in your own tree and
file the recurrence as a process defect. The tripwire counts merges
attempted against a live destination only; absorb iterations inside the
delivery rehearsal's private copy are not integration rounds and never
count toward it. A slice with nothing to merge — a zero-diff validator,
a finding-only slice, a gate whose absorb turned out to be a verified
no-op — still calls`merge-git-tree`unconditionally: the no-op merge
itself publishes the completion stamp that makes the Shadow reapable
via plain`complete-agent`, and skipping the call because "there's
     nothing to merge" leaves it with no completion proof at all.

     **Confirm, then wait for the claim — never reap in the same turn as the
     merge.** Immediately after `merge-git-tree` succeeds, send the Shadow
     exactly one `send-agent` confirmation that its merge landed (e.g. "merged
     into <branch>; you may publish your reapability claim"). Then end your
     own turn idle, publishing `{"blocked":true}` with a
     `__BLOCKED_BY_<slice_addr>__` marker per the existing blocked-marker
     convention (Rule 3 above) — do not call `reap-agent` in the same turn
     you send the confirmation. Reaping immediately would give the Shadow no
     turn to publish its claim and recreate the same deadlock one message
     later. The Shadow's own reapability-claim message is what wakes you; only
     in the turn that message arrives do you tear the Shadow down (tab +
     worktree + `data/$slice_addr/`) via
     `reap-agent "$slice_addr" --reason completed`. A Shadow that stays silent
     past the standing heartbeat interval is not a new waiting policy — it
     falls to the same "When a Shadow dies or is rate-limited mid-run"
     decision above: one `agent-logs` check, then relaunch the registered dead
     Shadow or reap it and spawn a fresh one with a tightened assignment. If
     you ever need to resend the confirmation (for example after a relaunch),
     make it differ in content from the first — a byte-identical resend is
     deduplicated by content hash and returns the same message id, so an
     identical retry never lands as a new message.

     **Commit-before-report is machine-gated, not merely instructed.** Both
     `complete-agent` and plain `reap-agent --reason completed` (no
     `--force`) run `checkOwnWorktreeCommittedPrecondition`
     (`src/slice-evidence/agent-evidence-gate.ts`) and refuse to reap an
     agent whose own recorded worktree still carries uncommitted **tracked**
     changes — staged, modified, or deleted files git already knows about.
     Untracked debris (a scratch note, a stray probe script, a stray
     `node_modules`) never trips it; the check is equivalent to `git status
--porcelain --untracked-files=no`. The refusal names the concrete
     remedy (`git add -A && git commit`) and the agent's own branch. Three
     cases are exempt, each its own distinguishable outcome rather than a
     shared silent pass: `deliverable_shape: "verdict-only"` agents (an
     answer-only deliverable produces no diff by design),
     `isTerminalDeliveryShadowName` (`99c`, and legacy `99b`/`99e`) agents (their content lands via
     their supervising Alpha's branch, not their own), and agents with no
     resolvable `spawn.json` cwd / `tree-base.json` branch (nothing to check
     against). **Honest limit:** this does not recover uncommitted
     in-progress work lost before a commit — it only prevents an agent from
     being accepted as COMPLETE while committed-but-unreported work still
     sits on disk. `--force` still tears the agent down over a dirty tree
     but prints a loud warning naming what was skipped instead of silently
     skipping it.

  The orchestrator (you, the Alpha) still owns the queue, ordering, active-plan
  resolution (Rule 6), and merge-back; a Shadow executes only its one slice.
  `99a_conform`, `99b_verify` and `99c_deliver` run in order after all ordinary slices as three distinct fresh real Shadows when applicable. If a 99 slice is not applicable to the exact request, simulate its contract, record `N/A — no-op` with the reason, and do not spawn or execute it; report the no-op explicitly. Applicable gates retain their normal dependency chain and use `rolePools.ShadowSlice99`; none may be Alpha-executed. The `99d` record step that follows `99c` is not a gate and is the one terminal todo the Alpha performs itself; see "`99d` — record the outcome on the Lord's page".
  When the bundle has a `98_ticket_` todo, `99a_conform` does not start until that todo records `**Ticket alignment outcome:** PASS`; see "`99a` waits for the ticket-alignment check" below.

  The following campaign-topology rules are `git-repo` only. **Propagation is
  deliberate:** a slice tree no longer inherits what other campaigns land
  while it works; when your campaign needs the target branch's latest, pull it
  into your own tree with plain documented git — `git -C <alpha-tree> merge
<target-branch>` (usually `main`) — and resolve any conflict there.
  **The campaign lands once:** your Alpha branch accumulates every slice and
  reaches the target branch exactly once, via your own merge-back at campaign
  end — one reviewable branch, never slices braided one by one into the
  target.
