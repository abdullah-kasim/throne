---
name: autoscaler
description: 'This throne-only, STAGER-ONLY skill pauses or resumes the whole court''s spawning by flipping `steering.autoscaleEnabled` in the live throne''s gitignored `config.user.ts`. Invoked by /autoscaler off | on | status, or when the Lord says "disable the autoscaler", "pause the throne", "stop spawning alphas", "stand the autoscaler down", "resume the autoscaler", or "is the autoscaler on?". Only a registered Stager may run it; the Regent, an Alpha, or a Shadow must refuse and relay to a Stager.'
version: 1.0.0
user-invocable: true
---

# Pause / resume the autoscaler (Stager only)

Since 2026-09-02 the alpha-autoscale worker's env switch
(`THRONE_ALPHA_AUTOSCALE_ENABLED=1`) is PERMANENTLY ARMED in both service
templates (`systemd/throne-backend.service`, `launchd/com.throne.throne-backend.plist`).
The Lord's order of the same day: the operator pause therefore lives in
`config.user.ts`, as `steering.autoscaleEnabled`. This skill is that flip,
made repeatable and verified.

What "paused" means: every alpha-autoscale tick (cron every 5 minutes, and
the manual `throne alpha-autoscale-tick`) logs
`skip: autoscaler disabled in config.user.ts (steering.autoscaleEnabled: false) ...`
and returns BEFORE auto-brief, deferral promotion, or any queue read — no
Alpha is born, no queue row is touched, and no floor-breach page is sent
(the breach is the operator's deliberate state). Everything else keeps
running: keep-going, no-idling, autoreap, dispatch, the Regent and live
agents. Paused means "the throne takes on no new campaigns", not "the court
is dead".

The worker re-reads the file on EVERY tick (`readAutoscaleEnabledInUserConfig`
in `src/alpha-autoscale/kill-switch.ts`, cache-busted import). No backend
restart in either direction.

## Who may run it

1. Read `~/.throne/data/<your-name>/identity.md`. The `Role:` line must be
   `Stager`. Any other role REFUSES loudly and relays the request to a live
   Stager (`throne send-agent <stager> ...`). The Stager is the one role that
   works against the live main checkout, where the one `config.user.ts` that
   the backend reads lives.
2. Resolve the live throne root with the same throne-context guard the todo
   skills use. Outside the live throne, refuse.

## Arguments

| argument | effect |
|---|---|
| `off` | write `steering.autoscaleEnabled: false` — pause |
| `on` | write `steering.autoscaleEnabled: true` — resume (absent also means on; write `true` explicitly so the intent is visible) |
| `status` (or none) | report the current effective value; write nothing |

## Procedure

1. `cat <live-throne-root>/config.user.ts`. If absent, start from
   `config.user.example.ts` — a file with ONLY a `steering` section is valid.
2. PRESERVE, DON'T REPLACE: keep every existing section and key
   (`addressTitle`, `ntfy`, `identity`, `roleplayPreset`,
   `activePlanPresetName`, `activeTargetEffort`, `customPlanPresets`,
   `stagerPool`, `tokenBalanceEnabled`, ...) exactly as it stands. Change only
   `steering.autoscaleEnabled`. Write a one-line comment above it with the
   date and the Lord's order.
3. Verify, by the smallest real check:
   - Both directions: `throne list-harnesses-and-models` must load without an
     error naming `config.user.ts` (any command loads the file at start; a
     load error means the write is malformed — fix the file, never add a
     bypass).
   - `off`: run `throne alpha-autoscale-tick`. It is SAFE while paused — it
     must print exactly one `skip: autoscaler disabled in config.user.ts ...`
     line and nothing else. Anything else means the pause is not in effect.
   - `on`: do NOT run the tick as verification — a live tick with launchable
     work spawns a real Alpha. Verify the value with:
     `node -e "import('./src/alpha-autoscale/kill-switch.ts').then(async m => console.log(JSON.stringify(await m.readAutoscaleEnabledInUserConfig())))"`
     run through `node --import ./test/register-typescript.mjs` from the live
     root, expecting `{"enabled":true}`.
   - `status`: the same one-liner; report its output verbatim.
4. Report to the Lord: the value written, the verification line verbatim,
   and — for `off` — that the cron tick will keep logging that skip line
   every five minutes until `on`, that live agents and the Regent are
   untouched, and that any launch-eligible queue rows simply wait.

`config.user.ts` is gitignored: nothing to commit, no YOLO checkpoint to
advance. Never edit the service templates or `kill-switch.ts` to "pause"
— the env switch stays armed by the Lord's order; this field is the pause.
