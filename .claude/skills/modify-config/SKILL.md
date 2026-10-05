---
name: modify-config
description: This throne-only skill changes the throne's machine-local config.user.ts safely. Use it for /modify-config, or when the task says "change the config", "edit config.user.ts", "put the Alphas on opus", "put X on <model>", "set the effort", "change the Stager model", "change the Regent model", or "pause the autoscaler". It says where the file lives, what it can and cannot change, how to edit it without losing sections, how to prove the edit loaded, and who may edit it.
---

# Modify config.user.ts

## Where the file is, and why

- `config.user.ts` lives only in the **live throne root** (the main checkout)
  and is gitignored. A worktree never has a copy, and every agent anywhere
  reads the live root's copy. Edit it by absolute path. Never `cd` into the
  live root to do it, and never create a `config.user.ts` in a worktree: it
  would be ignored, and you would believe you had changed something.
- `config.user.example.ts` (committed) documents every field with commented
  examples. `docs/CONFIG.md` holds the long reference.
- **When a change takes effect:**
  - `steering.autoscaleEnabled` is read fresh on every autoscaler tick, so it
    applies on the next tick with no restart.
  - Every other field is read once when a process starts. A new model or
    effort therefore applies at each agent's **next launch** (a fresh spawn,
    an autoscaler launch, a Regent resurrection). `/restart-harnesses`
    applies a new **effort** to running agents now. It resumes each agent's
    own session, so a new **model** still waits for the next fresh launch.
  - The backend workers are long-lived: after editing a field they read at
    startup, rebuild and restart the backend (`npm run build`, then the
    service restart your install uses).

## What it CAN do

Top-level sections: persona fields at the top level, `ntfy`, `steering`,
`identity`, `recall`. The `steering` section decides what every role runs:

| Field | Type and allowed values | Default | Read by |
| --- | --- | --- | --- |
| `activePlanPresetName` | a built-in (`GptOnly`, `AnthropicOnly`, `Optimized`, `Whichever`, `UnifiedRouting`, `OpusOnly`) or a `customPlanPresets` key | `OpusOnly` (claude/opus for every campaign role) | every fresh Alpha, Shadow and ShadowSlice99 spawn |
| `customPlanPresets` | `{ <Name>: { alpha, shadow, shadowSlice99 } }`, each a non-empty list of `{ harness, model }` | `{}` | the same spawns, once `activePlanPresetName` names it |
| `activeHarness` | a harness name | absent (each pair as written) | campaign-role spawns; never the Stager |
| `stagerPool` | non-empty list of `{ harness, model }` | absent (the committed Stager pin) | every Stager spawn, including the autoscaler's floor Stager |
| `regentRoute` | one `{ harness, model }` | absent (old launch: the recorded route at effort 1, or the bare launcher) | Regent resurrection and `summon-regent` |
| `activeTargetEffort` | integer 1 to 6 | `1` | the effort of any role `roleEfforts` leaves out |
| `roleEfforts` | `{ alpha?, shadow?, shadowSlice99?, stager?, regent? }`, each an integer 1 to 6 | `{}` | every fresh spawn of that role, switch-agent-model, `/restart-harnesses`; `regent` only when `regentRoute` is set |
| `messageQueueTransport` | `'sqlite'` | absent | message delivery |
| `tokenBalanceEnabled` | boolean | `false` | the token-balance load balancer |
| `autoscaleEnabled` | boolean | `true` | the autoscaler, on every tick |
| `regentHeartbeatNudgeEnabled` | boolean | `false` | the Regent heartbeat timer |
| `macLoadPerCoreAtCapacity` | number above 0 | `5` | on macOS, the 1-minute load per core at which the autoscaler and `resource-pressure` say at-capacity (load ≥ this × cores); Linux keeps load inside the 70-graded figure. The long-lived backend reads it at start, so restart it after a change |

The other sections, each field listed in `docs/CONFIG.md`:

| Section | Fields | Read by |
| --- | --- | --- |
| persona (top level) | `roleplayPreset`, `addressTitle`, `tierTitles`, `throneTitle`, `campaignTitle`, `queueDescription`, `roleplayPrompt` | every identity text and prompt |
| `ntfy` | `serverUrl`, `topic` | phone notifications |
| `identity` | `name`, `email`, `signingKey`, `signingFormat`, `identities`, `remotes` | every signed commit the court makes |
| `recall` | `jevEnabled`, `jevKeyFile`, `hookEnabled`, `hookMode`, `verdictLineThreshold`, `hookTimeoutMilliseconds`, `serveThreshold`, `serveThresholdWhenCostIsHigh`, `siftKeepThreshold`, `maximumInjectedCharacters`, `repositoryMemoryNamesPerRepository`, `globalMemoryDirectories`, `rankAllowedRoots`, `jevTokensPerDay`, `jevTokensPerHour` | `throne recall`, `sift`, `rank` |

**Effort scale.** 1 to 6, clamped to each model's range. On claude: 1 low,
2 medium, 3 high, 4 xhigh, 5 max. "High effort" means 3.

**Recipes** (invented values; use the Lord's):

- Put the campaign roles on a model: define a custom preset and name it.
  ```ts
  customPlanPresets: {
    DeepWork: {
      alpha: [{ harness: 'claude', model: 'opus' }],
      shadow: [{ harness: 'claude', model: 'opus' }],
      shadowSlice99: [{ harness: 'claude', model: 'opus' }],
    },
  },
  activePlanPresetName: 'DeepWork',
  ```
- Put the Stager on a model: `stagerPool: [{ harness: 'claude', model: 'opus' }]`.
- Put the Regent on a model: `regentRoute: { harness: 'claude', model: 'opus' }`.
- Effort per role: `roleEfforts: { alpha: 3, shadow: 3, shadowSlice99: 3, stager: 3, regent: 3 }`.
  Every role left out uses `activeTargetEffort`.
- Pause the autoscaler: `autoscaleEnabled: false` (or the `/autoscaler` skill).
- Cap what Jev may spend on this machine: `recall: { jevTokensPerDay: 3_000_000, jevTokensPerHour: 400_000 }`.
  The hour is rolling (the last 60 minutes) and the day is the local calendar
  day. Either limit at `0` switches Jev off; once a budget is used up the
  keyword rules answer until it frees up.

## What it CANNOT do

| Wanted | Where it lives instead |
| --- | --- |
| One queue row on a different model | `add-to-queue --model-hint` at filing |
| One queue row at a different effort | `add-to-queue --effort` at filing; it outranks `roleEfforts` for that campaign |
| A sliceless or shadowless campaign | the Lord's own words for that row at filing; config never defaults a row to it |
| A model the registry does not know | a registry change in code (`src/harness-routing/model-registry.ts`), then a rebuild |
| The service environment, including the autoscaler's environment switch | `install-services`; it is baked into the unit files |
| A new model on an already running agent | `switch-agent-model`, or its next fresh launch |
| A new config field | code: the field must be added to the loader and its validator first |

## How to edit it safely

1. Read the **whole** file first.
2. Change only the fields you were asked to change. Preserve every other
   section and the file's leading comment. Never rewrite the file from a
   fresh object: that silently drops `identity` and `recall`, and every
   commit and recall afterwards breaks.
3. One field at a time. Model names must be registered pairs
   (`throne list-harnesses-and-models`); one unknown name refuses the whole
   file at load and every throne command fails.
4. Run `throne check-config` **before** the edit and again **after** it. It
   loads and validates the file and prints each role's model and effort.
   Show the Lord the two outputs side by side.
5. Tell the Lord what changes when (see above).
6. Never commit it. It is gitignored for a reason.

## Who may edit it

Only on the Lord's own order. A Stager or the Regent edits the live file
directly. An Alpha edits it only when its queue row says so. A Shadow
never does.
