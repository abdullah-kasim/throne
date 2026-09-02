# When `throne-keep-going.timer`/`.service` may be retired

`throne-keep-going.timer` and `throne-keep-going.service` stay installed and
enabled as the fallback path for regent resurrection even after
`throne-backend` hosts the same keep-going logic as one of its cron workers.
Retirement is a future, deliberate operator decision, not a default outcome
of the hosted worker existing — the standalone timer keeps running
indefinitely until every condition below has been checked and recorded. All
four must hold at once; none is sufficient alone.

## 1. The hosted worker has demonstrably resurrected a Regent in production

The `throne-backend`-hosted keep-going worker must have actually driven at
least one real Regent resurrection while running as a systemd-managed
service — not only in a test suite or a local dev shell. Evidence lives in
the throne-backend journal (`journalctl --user -u throne-backend -g
resurrect`) or in an `agent-statuses`/ledger record showing a resurrection
timestamped to a hosted-worker tick rather than the standalone timer's
oneshot run. Cite the specific log line or record found, not the fact that
the code path exists.

## 2. The `WatchdogSec=` watchdog has demonstrably fired and restarted the process

The watchdog protects against `throne-backend` going wedged-but-alive; that
protection is unproven until it has actually tripped once. Evidence lives in
`journalctl --user -u throne-backend -g watchdog`, which shows systemd's own
"Watchdog timeout" message immediately followed by the unit's
`Restart=always` bringing it back up. A watchdog that has never fired is a
watchdog that has never been exercised, deliberately or by a real wedge —
retirement cannot rely on an unexercised safety net.

## 3. A minimum of 14 consecutive days with zero standalone-timer fallback saves

Across 14 consecutive calendar days, `throne-keep-going.service` must have
run its scheduled ticks (`journalctl --user -u throne-keep-going.service`)
without any of those ticks actually resurrecting or nudging a Regent that
the hosted worker should already have caught. Fourteen days is chosen
because it spans two full weekly operating cycles at the 30-minute keep-going
cadence — roughly 672 standalone-timer firings — long enough to catch a
once-a-week-shaped failure mode in the hosted path (a cron misfire tied to a
specific day, a resource contention window that only appears on one day of
the week) rather than just a lucky 24-hour window. If any fallback save is
observed inside the 14-day window, the count resets to zero from that save.

## 4. A recorded check that nothing else still depends on the standalone unit's existence

Before retirement, whoever retires the standalone timer must grep the
codebase and operator tooling for its unit names
(`throne-keep-going.timer`, `throne-keep-going.service`) across scripts,
systemd wrapper commands (`install-services`, `ensure-heartbeat`), and docs,
and record what that grep found. `ensure-heartbeat` renders and arms this
timer/service pair as part of its self-heal behavior as of this writing, so
retirement is not just deleting the unit files — it also requires updating
`ensure-heartbeat` (and any other caller found by the grep) to stop treating
the standalone pair as something to install and arm. Retiring the unit files
while a still-live caller expects them to exist would silently reintroduce
the exact "wedged but alive, and now nothing resurrects it" failure this
whole design exists to prevent.

## Until all four hold

`throne-keep-going.timer`/`.service` are not disabled, not stopped, and not
removed. They run alongside `throne-backend`'s hosted keep-going worker as
two independent processes capable of calling the same resurrection path, by
design, for exactly as long as it takes to accumulate this evidence.
