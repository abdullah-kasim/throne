---
name: usage
description: Throne-only usage dashboard. Trigger when the Lord says “usage” or asks about quota, limits, burn rate, reset timing, or projected exhaustion. Reports current harness limits, remaining percentages, burn rates, reset times, and projected percentage at reset (including negative values) as a table.
---

# Usage dashboard

This skill is throne-only. Run from the live throne root; do not delegate.

Run these read-only commands:

```bash
./bin/throne-cli plan-usage-remaining --json
./bin/throne-cli codex-usage-remaining --json
./bin/throne-cli usage-rate --json
```

## Which providers to report

Report **every provider that returns live data**, Claude included.

Claude was previously excluded here on the premise that the operator held no
Claude subscription. That premise is false: `plan-usage-remaining` returns real
Claude windows, and since the active plan preset routes every campaign role to
`claude/sonnet`, Claude is where the court's quota is actually spent. Omitting it
produced a dashboard that reported only the **idle** provider — worse than
useless, because it read as "safe" while saying nothing about the harness under
load.

Report a provider only from data it actually returned. Never infer usage for a
harness with no data; list it as unavailable instead. OpenCode Go is normally
unavailable — say so in one line rather than dropping it silently.

## Output format

**Lead with the risk verdict**: “safe”, “likely exhausted before reset”, or
“insufficient/stale data”. Justify it in one sentence naming the worst window.

Then one table, one row per harness cap window, most-loaded provider first:

| Harness | Window | Remaining | Used | Burn (today) | Burn (7-day) | Resets in | Projected at reset | Exhausts in |
|---|---|---|---|---|---|---|---|---|
| claude | weekly | 65% | 35% | 0.44 %/h | 0.47 %/h | 43.2 h | 38.7% | ~139 h |
| codex | weekly | 100% | 0% | 0 %/h | 0.21 %/h | 164.6 h | 64.7% | ~466 h |

Column rules:

- **Remaining / Used** — as reported; include `scope_model` in the Window cell
  when present (e.g. `weekly:Fable`, `weekly:GPT-5.3-Codex-Spark`).
- **Burn** — `pct_per_hour`, today and trailing seven days. A today-rate of 0
  usually means the harness is idle *by routing policy*, not that consumption
  stopped; note that under the table when it applies.
- **Resets in** — hours until reset, computed from that window's own `as_of`,
  not from the anchor.
- **Projected at reset** — prefer the API's `projected_remaining_pct`; otherwise
  compute `remaining_pct - seven_day_rate × hours_until_reset`. When the API
  value and the seven-day computation disagree materially, show BOTH and say
  which basis each uses — the API figure often rides on a zero today-rate and is
  the optimistic one.
- **Exhausts in** — only when remaining and burn rate are both positive:
  `remaining_pct / seven_day_rate`. Otherwise `—`.

**Never clamp a negative projection.** Negative means the current burn rate
would exhaust that limit before it resets; show the negative number.

Below the table, add only what the table cannot carry:

- stale readings (state the `as_of` lag against the anchor), failed token
  refreshes, missing windows, unavailable providers, and any error/severity
  fields;
- one line on routing context when a provider is idle purely by policy;
- nothing else. No restatement of the rows in prose.
