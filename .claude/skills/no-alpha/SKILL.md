---
name: no-alpha
description: Perform a requested throne task directly in the invoking agent's own session — the Regent or the Stager, whichever the Lord addressed — without spawning or using an Alpha. Trigger on $no-alpha, $na, "no alpha", "without an alpha", or an explicit request to do the work directly. This is a throne-only skill and refuses outside the live throne orchestrator.
---

# Direct execution without an Alpha

Use this skill only when the Lord explicitly requests work without an Alpha.
It applies to whichever agent the Lord addressed — the Regent or the Stager
execute directly in their own session (the Lord's ruling of 2026-08-17:
no-alpha "works for you too"; the hazard it guards is WHICH task, not WHO).
The scope confirmation in step 0 is what makes Stager-direct work safe: a
Stager acts directly ONLY on a scope the Lord has confirmed, never on an
inferred one.

0. MANDATORY SCOPE CONFIRMATION: before any action, ask the Lord which exact
   task this no-alpha invocation covers, as a multiple-choice question
   (AskUserQuestion when available in the harness; otherwise a plainly
   formatted numbered-options message). Derive the options from the plausible
   candidate tasks in the current conversation and queue context — the most
   recently discussed task first and marked (Recommended) — always leaving
   the ordinary Other/free-text escape for a task not listed. Do not begin
   executing until the Lord has answered. A no-alpha invocation whose scope
   was never confirmed is a defect, not a shortcut, no matter how obvious the
   task seems. (The Lord's ruling of 2026-08-17, after a misread "no alpha"
   caused an unintended direct implementation.)
1. Resolve the live throne root using the same throne-context guard as the
   todo skills. Refuse loudly outside that root; do not silently fall back to
   ordinary direct work.
2. Read the live queue and current agent roster before acting. Do not spawn an
   Alpha, Shadow, or hidden in-harness worker for this invocation.
3. Execute the Lord's scoped request directly in the invoking agent's own
   session. Preserve unrelated queue work and ambient changes.
4. Resolve ambiguity by best judgment; never ask the Lord to choose between
   implementation options — the one mandatory question is the scope
   confirmation above (WHICH task, step 0); it is never repeated for
   implementation choices (HOW is yours to decide).
5. Verify the requested outcome with the smallest relevant focused checks.
6. For every file edit, commit immediately with a descriptive message and
   update the YOLO checkpoint before making another edit.
7. Report the direct changes, validation evidence, and any precise residual
   blocker. Do not claim Alpha or Shadow evidence that does not exist.

The `$na` alias is exactly this skill; it adds no alternate behavior.
