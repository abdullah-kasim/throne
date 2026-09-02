---
name: switch-campaign-model
description: This throne-only, STAGER-ONLY skill moves the whole campaign workflow — Alpha, ordinary Shadow, and the terminal ShadowSlice99 gates — onto one model by rewriting `steering` in the live throne's gitignored `config.user.ts`. Invoked by /switch-campaign-model [model] (default sonnet), or when the Lord says "switch to sonnet for the whole alpha/shadow/99 workflow", "run every campaign role on <model>", "put the court on <model>", or "switch the campaign model". Only a registered Stager may run it; the Regent, an Alpha, or a Shadow must refuse and relay to a Stager.
---

# Switch the campaign model (Stager only)

The Lord's order of 2026-09-02 to `stager-floor` ("switch to sonnet for the
whole alpha/shadow/99 workflow") was carried out by rewriting the `steering`
section of `config.user.ts`. This skill is that action, made repeatable.

## Who may run it

1. Read `~/.throne/data/<your-name>/identity.md`. The `Role:` line must be
   `Stager`. Any other role — Regent, Alpha, Shadow — REFUSES loudly and
   relays the request to a live Stager (`throne send-agent <stager> ...`).
   Reason: the Stager is the one role that works in the live main checkout,
   where `config.user.ts` lives; every other role sits in a worktree whose
   copy of that file is not the one `create-agent` reads.
2. Resolve the live throne root with the same throne-context guard the todo
   skills use. Outside the live throne, refuse; do not write a stray
   `config.user.ts` into some unrelated repository.

## Which model

The argument is a model slug from `throne list-harnesses-and-models`
(`sonnet` when omitted). Map it to a preset:

| model | preset to name in `activePlanPresetName` |
|---|---|
| `sonnet` | built-in `UnifiedRouting` (Alpha, Shadow, ShadowSlice99 all `claude/sonnet`) |
| any other registered model | a `customPlanPresets` entry named `<Model>Only`, whose `alpha`, `shadow`, and `shadowSlice99` pools each hold the single `{ harness, model }` pair. The harness is whatever the registry lists for that model (`claude` for Anthropic models, `codex` for `gpt-*`). |

Do not reach for `AnthropicOnly`/`Optimized` as shortcuts for fable or opus:
their Shadow pools are wider than one model, which is not "the whole
workflow on one model".

## Procedure

1. `cat config.user.ts` in the live throne root. If absent, start from
   `config.user.example.ts`.
2. PRESERVE, DON'T REPLACE: keep every existing section and key
   (`addressTitle`, `ntfy`, `identity`, `roleplayPreset`, ...) exactly as it
   stands. Change only `steering.activePlanPresetName` and, for a non-sonnet
   model, add/replace the one `steering.customPlanPresets.<Model>Only` entry.
   Leave `activeTargetEffort`, `tokenBalanceEnabled`, and `stagerPool` alone.
3. Write a comment above `activePlanPresetName` stating the date, the Lord's
   order, and that the Stager is deliberately NOT covered (it stays on its
   committed `claude/opus` pin unless `stagerPool` is set — never set it as a
   side effect of this skill).
4. Verify: `throne list-harnesses-and-models` must print
   `preset: <name>` with `Alpha`, `Shadow`, and `ShadowSlice99` all equal to
   the requested pair and `Stager` unchanged. A load error naming
   `config.user.ts` means the pair is not in the registry — fix the slug, do
   not invent a bypass flag.
5. Report to the Lord: the three role lines from step 4, verbatim. Say
   plainly that this affects FRESH spawns only — `ACTIVE_PLAN_PRESET` is
   computed per CLI invocation, so no restart is needed, but live agents keep
   their recorded route (`switch-agent-model` is the separate tool for those,
   and this skill never runs it).

`config.user.ts` is gitignored: there is nothing to commit and no YOLO
checkpoint to advance. Do not touch `src/config.ts` or the built-in presets.
