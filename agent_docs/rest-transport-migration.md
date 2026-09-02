# REST transport migration — retirement criteria for the in-process CLI path

Every `throne-cli` command still runs as a short-lived in-process invocation
by default. This bundle added a second way to run a command: over a UNIX
domain socket to the already-running `throne-backend` process. This doc
records the migration-law obligations (AGENTS.md, "Migration law") for this
transport specifically, and the concrete criteria that would justify ever
retiring the in-process path.

## The transport, as landed

- **Socket path.** `resolveTransportSocketPath()`
  (`src/transport/transport-wire-contract.ts`) resolves to
  `RUNTIME_DATA_HOME/state/throne-backend.sock` — a filesystem AF_UNIX path,
  never a TCP port.
- **CLI flags.** `--transport rest` opts a migrated command into the REST
  path; the default (flag absent) is `local`, i.e. the untouched in-process
  path. `--local` is a blanket override: it forces `local` regardless of
  `--transport`, for any command that parses it. Both are decided in one
  place, `resolveTransportMode()` (`src/transport/resolve-transport-mode.ts`).
- **Rescue set.** `RESCUE_SET_COMMAND_NAMES` in
  `src/transport/resolve-transport-mode.ts` names exactly four commands that
  `resolveTransportMode()` always resolves to `local`, regardless of
  requested flags: `status`, `install-services`, `agent-statuses`,
  `send-agent-legacy`. These command names are verified against their own
  `@Command({ name: ... })` decorators in `src/status/status.command.ts`,
  `src/install-services/install-services.command.ts`,
  `src/agent-statuses/agent-statuses.command.ts`, and
  `src/send-agent-legacy/send-agent-legacy.command.ts`. None of them touch
  the socket at all — the transport is architecturally absent from their
  code paths, not merely defaulted off.
- **Migrated command.** `message-status` is the one command wired to the REST
  path (`src/message-status/message-status.command.ts`). It parses
  `--transport`/`--local` itself, calls `resolveTransportMode()`, and on
  `"rest"` sends the request through `TransportClient.request()`
  (`src/transport/transport-client.ts`) to route path
  `MESSAGE_STATUS_ROUTE_PATH` (`"message-status"`,
  `src/message-status/message-status.ts`); on `"local"` it calls
  `runMessageStatus()` in-process exactly as before this bundle existed.

## The four migration-law obligations, answered for this transport

**1. The old path stays live until the new path has earned retirement.**
`resolveTransportMode()` returns `"local"` whenever `--transport` is absent
— confirmed in `MessageStatusCommand.run()`, which computes `mode` from
`resolveTransportMode({ transport, local }, "message-status")` and falls
through to `runMessageStatus()` unchanged on anything but an explicit
`"rest"`. The REST path is opt-in per invocation; nothing was replaced.

**2. The fallback is reachable independent of the new path's health.** The
rescue set (`status`, `install-services`, `agent-statuses`,
`send-agent-legacy`) never constructs a `TransportClient` or touches the
socket — `resolveTransportMode()` short-circuits to `"local"` for those
names before even inspecting the requested flags. A wedged or dead
`throne-backend` cannot take these four commands down with it: they were
built to diagnose and repair the backend, which requires surviving its
death. For `message-status` itself, `--local` is a per-invocation escape
hatch, not a health check — it is unconditional, so it works even against a
backend that would otherwise poison every `--transport rest` call.

**3. What is shared between old and new paths.** One thing, deliberately:
the underlying logic function `runMessageStatus()` (`src/message-status/
message-status.ts`). The in-process path calls it directly from
`MessageStatusCommand.run()`; the REST path's server-side handler,
`handleMessageStatusRoute`, is registered in `buildProductionRouteHandlers()`
(`src/throne-backend/transport-route-dispatcher.ts`) and itself calls the
same `runMessageStatus()` internally. This is the one sanctioned exception
to AGENTS.md obligation 3 ("the fallback shares nothing"), and it is safe
specifically because it is the correctness-critical logic being shared, not
the plumbing: both transports must produce the exact same command behavior
for the same input, so a divergent implementation would itself be the bug.
What is *not* shared is everything AGENTS.md's obligation 3 actually warns
about — no shared store, schema, server process, or heartbeat: the socket,
the dispatcher, and the client are wholly new code paths that only exist for
`--transport rest`, and a fault in any of them cannot reach the in-process
call.

**4. Concrete retirement criteria.** The in-process path for `message-status`
should not be considered for retirement until all of the following hold:

- **N consecutive campaigns land on `--transport rest` for every migrated
  command with zero manual falls back to `--local`.** A reasonable floor is
  five consecutive campaigns; raise it if any fallback occurs during the
  count and restart the count from zero.
- **The failure modes this transport was built for have been observed in
  the wild and survived without incident** — specifically: a stale backend
  generation producing the loud warning
  `TransportClient.request()` emits via `checkTransportResponseStaleness()`
  (`src/transport/transport-staleness-check.ts`) rather than a silent stale
  success, and a wedged/dead backend correctly forcing use of the rescue set
  or `--local` rather than hanging or corrupting state.
- **An explicit check that nothing still depends on the in-process path
  being the *only* path.** Before removal, confirm no script, cron job, or
  other command assumes `message-status` (or any later-migrated command)
  has no `--transport` flag at all, and that `RESCUE_SET_COMMAND_NAMES`
  still resolves every rescue-set name to `"local"` unconditionally — the
  rescue set is exempt from retirement by design and must never be migrated.

Until all three hold, `message-status`'s in-process path stays exactly as it
is: the default, unconditionally reachable, and load-bearing for the rescue
set's own survival.
