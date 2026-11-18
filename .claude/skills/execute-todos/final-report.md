# The final report

## Final report shape

The campaign stays incomplete while the latest verify verdict is absent or
FAIL; only an explicit PASS from the latest fresh `99b` gate permits delivery.
That PASS permits only the `99bs` spec gate and then the mandatory delivery-only `99c`; successful
fresh-Shadow target inspection and delivered-feature smoke checks remain
required before completion is reported. The `99c` report also carries the
`merged_ref` its one-commit delivery merged in and reset onto.
The final report must surface the latest fresh gate's exact
`**Verify outcome:** PASS` or `**Verify outcome:** FAIL` in both campaign
status and the verification matrix. A completed failed gate remains a failed
campaign, not a completion.

When the queue has an explicit `**Verify outcome:** PASS` and the subsequent
`99c` Shadow has completed its mode-specific terminal contract — exact-one-commit
delivery plus target inspection/smoke checks for `git-repo`, or explicit Git N/A
evidence plus independent final operational-state validation for `no-git` — the
**first terminal action** before
anything else — is writing
`$THRONE_DATA/$ALPHA/REPORT.md`: the durable completion signal `complete-agent`
and `listCompletedAgents` verify before a campaign Alpha can be reaped. Only
after that file lands do you perform the `99d` record step
("`99d` — record the outcome on the Lord's page"), and only after
its check passes do you send the chat summary to your supervisor. Never
write `REPORT.md` mid-work, speculatively, or on a FAIL/absent verdict — its
presence on disk IS the reap-ready signal, not a courtesy copy of the chat
report. When you are ready to be reaped, tell your supervisor first (the
primary, never-dropped requirement), then publish the canonical claim supplied
by the generated assignment's completion section.

`REPORT.md` (and the chat summary you send afterward) both carry three separate
required sections before the existing campaign bookkeeping:

1. **Implementation accounting** — exactly what was implemented to fulfill the
   requested scope: changed files, delivered behavior, key decisions, and
   explicit boundaries. This section is mandatory in both `REPORT.md` and the
   Alpha DONE to Regent. It must stand on its own and must not be blended into
   the E2E section. Bare `done` is invalid.
2. **Real E2E run** — the exact real proof that ran: real stack/transport,
   setup, exact commands/actions, observations/evidence, verdict, and any
   deviation from the plan. This section is mandatory in both `REPORT.md` and
   the Alpha DONE to Regent. A bare `E2E passed` claim or a synthetic/mock-only
   route is invalid.
3. **Platform-first audit** — the concrete audit that governed planning and was
   re-checked after recon: current stdlib/platform/installed-dependency
   primitives considered, reuse or thin-wrapper decision, any custom machinery
   accepted, and concrete evidence for each guarantee the existing primitives
   could not provide. This section is mandatory in both `REPORT.md` and the
   Alpha DONE to Regent. A custom mechanism without the audit or without
   evidence for a claimed gap is invalid.

After those three sections, `REPORT.md` (and the chat summary you send afterward)
also carry:

4. **Done** — list of todos completed, one line each, each tagged with the actual harness/model plus the effort the engine resolved (e.g. `03 wire_route — claude sonnet / effort 1` or `03 wire_route — codex gpt-5.4 / effort 1`). Lead the section with the active plan preset and exact role pools used, active `MODE`, todo-run personality, and model mix (e.g. "preset=UnifiedRouting; optimized: 5×sonnet, 1×opus, 1×gpt-5.6-sol; personality=focused").
5. **Skipped** — list of todos skipped + reason (later / blocked-on-user / not-actionable).
6. **Verification matrix** — begin with the latest fresh `99b` gate's explicit `**Verify outcome:**` line, then show what was actually verified (the commands it ran + their pass/fail) vs what's only structurally assumed (e.g. "compiles" vs "tested on hardware"). For an explicitly legacy bundle carrying an older gate chain, fold in its per-criterion pass/fail against the whole authoritative `00_overview.md`. Keep measured rows (a command and its outcome) visibly distinct from rows carried forward from a prior gate (that earlier verdict plus its untouched-proof); a reader must never have to guess whether a row was measured or carried forward.
7. **Real follow-ups** — partial work, infrastructure gaps the workers flagged, things the user owns next.
8. **Open questions digest** — the full `000_current_questions.md` (or a digest of it), leading with the blocking / irreversible ones, so the user knows what assumptions the run rode on.

`REPORT.md` must also carry a `## Outcome` section in exactly this shape. The
reap reads it and records it on the campaign's queue row, so a later look-back
can tell what the work achieved without reading the prose:

```markdown
## Outcome

- **Outcome:** merged
- **Outcome summary:** The pull request adding saved recipes was squash-merged.
- **PR:** https://git.example.com/shop/recipes/pull/42
- **Result commit:** 3f9c2ab
```

`- **Outcome:**` takes exactly one of these values:

- `delivered` — the work landed on the recorded target branch.
- `merged` — a pull request or branch was merged by its host.
- `refused` — the host or a guard refused the merge or push.
- `blocked` — the work could not proceed and nothing landed.
- `abandoned` — the work was stopped deliberately.

`- **Outcome summary:**` is one plain sentence. Leave out the `- **PR:**` line
when there is no pull request, and the `- **Result commit:**` line when there is
no merge, squash or pushed-head commit; the reap then records the delivery
commit it found, if any. Any other outcome value is not recorded, and the row
reads `not recorded`.

Be honest about what's NOT verified — runtime errors from placeholder bodies, behaviour against the real third-party service, memory use under load. Mismatched optimism here costs trust and debugging time later.
