# ntfy phone notifications

This is the throne's self-hosted phone-push path for automatic campaign
completion notices and deliberate `notify-lord` messages. It is deliberately
**tailnet-only**: the server listens on the Tailscale address, not `0.0.0.0`,
and the Lord's phone must be on the same tailnet to receive pushes.

## Where the host's identity lives

The server address and topic are **host-local secrets** and are deliberately
absent from this repository: the server URL is a private tailnet address, and
the topic is an unguessable string that anyone holding it can push to the
Lord's phone with. They live in the gitignored `config.user.ts` at the live
throne root:

```ts
ntfy: {
  serverUrl: 'http://<tailnet-ip>:8410',
  topic: '<unguessable-topic>',
},
```

The committed tree carries an inert default instead
(`http://127.0.0.1:8410`, topic `throne-notifications`), so a fresh clone
pushes nowhere until that section is filled in. Precedence, highest first:
`THRONE_NTFY_SERVER_URL` / `THRONE_NTFY_TOPIC` env vars, then `config.user.ts`,
then the committed default.

## Lord handoff

Read the live values out of `config.user.ts`, then relay this block with them
substituted in:

```text
Phone notifications are live on the throne's self-hosted ntfy server.

Primary server URL: <serverUrl>
Full subscription URL: <serverUrl>/<topic>

Manual step on your phone:
1. Install the ntfy Android app from the Play Store or F-Droid.
2. Add a subscription.
3. Choose "Use another server".
4. Enter the server URL above and subscribe to the topic.

Precondition: your phone must be on the tailnet. This server is tailnet-only
by design, so it will not load off-tailnet.
```

## How the server runs

ntfy runs as a **container** on every throne host: the pinned
`binwiederhier/ntfy` image (`vendor-pins.json` → `tools.ntfy.image`) under
whichever OCI runtime the box has, `docker` or `podman`, detected in that
order (`THRONE_CONTAINER_RUNTIME=<name>` forces one). `./install.sh` pulls the
image; `systemd/ntfy-serve` runs it. No brew package, no binary: upstream
ships no macOS server binary and brew's mac formula is client-only, so a
container is the one shape that is identical everywhere, and it is
runtime-agnostic on purpose so a docker → podman move is a no-op for the
throne. The container is attached in the foreground with `--rm --name
throne-ntfy`, so stopping the unit stops it; a stale container from an
unclean stop is removed before each start. On an SELinux-enforcing host the
bind mounts get `:Z`.

## Tracked files

- `systemd/ntfy.service` — the linux user unit.
- `launchd/com.throne.ntfy.plist` — the macOS LaunchAgent (same wrapper,
  logs to `~/Library/Logs/throne/ntfy.log`).
- `systemd/ntfy-serve` — wrapper that waits for a real tailnet IPv4, then
  execs the container. Platform-aware: `ip`/`tailscale0` on linux,
  `ifconfig` and the `Tailscale.app` bundle CLI on a mac.
- `systemd/ntfy-server.yml` — host-neutral ntfy server config, bind-mounted
  read-only into the container; the host-specific `base-url` and `cache-file`
  values are derived at runtime by `ntfy-serve`.
- `src/notify-lord/notification.service.ts` — shared ntfy transport/defaults and the completed-agent fire
  predicate.
- `src/notify-lord/notify-lord.command.ts` — validation and user-facing behavior for
  deliberate Lord-facing messages.

`systemd/ntfy.service` is a throne-owned template: its `ExecStart` names the
wrapper and config through `{{THRONE_ROOT}}`, which `install-services`
substitutes when it renders the unit into the systemd user unit dir. The
substituted value must be the **live repo path**, never a Shadow worktree path
— a worktree is disposable, the live repo path survives reaps. Installing from
a worktree therefore takes `--throne-root <live throne path>`, which moves only
the path baked into the rendered unit.

## Start, stop, inspect

```bash
systemctl --user start ntfy.service
systemctl --user restart ntfy.service
systemctl --user stop ntfy.service
systemctl --user status ntfy.service
journalctl --user -u ntfy.service -n 100 -f
systemd-analyze --user verify ~/.config/systemd/user/ntfy.service
docker ps --filter name=throne-ntfy      # or podman
```

On macOS:

```bash
launchctl print gui/$(id -u)/com.throne.ntfy
launchctl kickstart -k gui/$(id -u)/com.throne.ntfy   # restart
launchctl bootout gui/$(id -u)/com.throne.ntfy        # stop (install.sh re-bootstraps)
tail -f ~/Library/Logs/throne/ntfy.log
```

Verify the **installed** unit, not `systemd/ntfy.service` in the repo. The repo
copy is a template, and `systemd-analyze` rejects the unsubstituted token —
measured on this host, `systemd-analyze --user verify ./systemd/ntfy.service`
exits 1 with `Neither a valid executable name nor an absolute path:
{{THRONE_ROOT}}/systemd/ntfy-serve` / `Unit configuration has fatal error`,
while the installed-unit form above exits 0 with no output.

## Network boundary

- `systemd/ntfy-serve` launches `<runtime> run --rm --name throne-ntfy -p
  "${tailnet_ip}:8410:80" -v <server.yml>:/etc/ntfy/server.yml:ro -v
  "${XDG_STATE_HOME:-$HOME/.local/state}/ntfy":/var/cache/ntfy <image> serve
  --config /etc/ntfy/server.yml --listen-http :80 --base-url
  "http://${tailnet_ip}:8410" --cache-file /var/cache/ntfy/cache.db` — the
  host bind address, advertised base URL, and cache path are all derived at
  runtime (ntfy CLI flags override config-file values), so `ntfy-server.yml`
  stays host-neutral. The `-p` binds the host side to the tailnet IP only;
  inside the container ntfy listens on its own `:80`.
- `src/notify-lord/notification.service.ts` resolves its POST target from
  `config.user.ts`'s `ntfy.serverUrl`, falling back to the inert
  `DEFAULT_SERVER_URL = 'http://127.0.0.1:8410'`, with
  `THRONE_NTFY_SERVER_URL` overriding both.

**Do not "simplify" this to `0.0.0.0`.** The host's default firewalld zone opens
high TCP ports on the LAN interface already. Binding `0.0.0.0:8410` would make
ntfy reachable from the local wireless LAN. The tailnet-IP bind is the
containment boundary.

If the server URL or port changes, update all three surfaces together:

1. `systemd/ntfy-serve` `-p` and `--base-url` (one port literal, used twice)
2. `systemd/ntfy-server.yml` `listen-http` (the loopback fallback used when
   the config is loaded without the wrapper)
3. `src/notify-lord/notification.service.ts` `DEFAULT_SERVER_URL` or the `THRONE_NTFY_SERVER_URL`
   runtime override

Then update the handoff block above so the Lord re-subscribes to the right URL.

## Boot behavior

- `systemd/ntfy.service` is a **user** service with `Restart=always` and
  `RestartSec=5s`.
- `systemd/ntfy.service` starts after `network-online.target` and gives startup
  `TimeoutStartSec=70`.
- `systemd/ntfy-serve` waits up to 60 seconds for an interface to hold the
  IPv4 returned by `tailscale ip -4`. If it times out, or the container
  runtime is not reachable yet (Docker Desktop still starting, a podman
  machine not up), the wrapper exits non-zero and the service manager
  restarts it.
- `launchd/com.throne.ntfy.plist` does the same on a mac with `KeepAlive`
  and the default 10-second `ThrottleInterval`.

That combination is the boot-race guard: Tailscale and the container runtime
may come up after the user manager, so the wrapper waits and the service
manager keeps retrying.

## Push sources

### Explicit Lord messages

```bash
./bin/throne-cli notify-lord <message...>
```

This command sends one deliberate Lord-facing message with ntfy title `Message
from the throne`. It single-space joins and trims the arguments, rejects an
empty result before any POST, and awaits one delivery attempt. It is an
intentional external side effect for text that should reach the Lord's phone,
not a hidden progress-log channel; use `send-agent` for communication within the
court.

### Automatic completion messages

- `./bin/throne-cli reap-agent <name> --reason <enum>` requires an explicit
  `--reason`; there is no inferred default.
- `src/notify-lord/notification.service.ts` sends a completion push only when `reason === 'completed'`.
- Completed `Alpha` reaps notify by default.
- Completed `Shadow` reaps notify only when `THRONE_NOTIFY_SHADOWS=1`.
- `complete-agent` routes its successful teardown through `reap-agent` with
  `--reason completed`, so completed campaigns hit the same notification path.

Automatic completion pushes retain the ntfy title `Throne campaign completed`.
Their message body starts with the campaign identity and optional objective,
followed by the live queue view when available:

```text
Campaign completed: <agent-name>
Objective: <objective heading>
# Regent queue (...)
```

If no objective heading is found, the `Objective:` line is omitted.
The automatic body is bounded to 4 KiB, the installed server's message-size
limit; oversized queue context ends with `Queue: [truncated]`. Deliberate
`notify-lord` messages retain their separate caller-provided message contract.

## Runtime overrides and rotation

`src/notify-lord/notification.service.ts` reads these env vars once per process when `NOTIFY_CONFIG` is
constructed:

- `THRONE_NTFY_SERVER_URL` — override the POST target URL.
- `THRONE_NTFY_TOPIC` — override the topic.
- `THRONE_NOTIFY_SHADOWS=1` — opt completed Shadows into pushes.

Because the config is captured once per process, set the env var **before**
starting the command or harness that will reap the agent. Changing the variable
later does nothing until that process restarts.

For a permanent topic rotation:

1. Pick a new unguessable topic.
2. Update `ntfy.topic` in the live `config.user.ts`, or ensure the long-lived
   process now exports `THRONE_NTFY_TOPIC=<new-topic>`. Never put it in the
   committed `DEFAULT_TOPIC`.
3. Re-subscribe the Lord's Android app to the new topic.
