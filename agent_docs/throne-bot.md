# throne-bot: Matrix chat fronted by Claude Code bots

`throne-bot` is a self-hosted, LAN/Tailscale-only Matrix chat (conduwuit)
where each room is fronted by a bot. It runs alongside the live throne but is
not a second throne: there is no Regent, no autoscaler, no Alphas, no
Shadows in the `throne-bot` herdr session — it hosts bot panes and nothing
else.

## Architecture

```
Element/Matrix client ⇄ conduwuit (systemd, tailnet-bound, unencrypted rooms)
                              │  client-server API (token auth)
                              ▼
                    throne-bot bridge daemon (one per bot, matrix-bot-sdk)
                    ── inbound: sync → format "<sender> said: <text>"
                       → existing per-pane delivery service (session
                         throne-bot) → bot's Claude Code pane
                    ── attachment: download via media endpoint →
                       ~/.throne-bot/data/<bot-name>/inbox/<eventId>.<ext>
                              │
                              ▼
                    bot pane (Claude Code, fable, persona system prompt)
                    ── files objective: `throne add-to-queue` (Bot role,
                       lint-objective-enforced DONE final step)
                    ── on `throne send-agent <bot-name> "DONE ..."`: relays
                       via `throne-bot say <bot> <text>`
                              │
                              ▼
                    live throne (session `throne`) — unmodified orchestration,
                    cross-session `send-agent`/`agent-statuses` search both
                    the `throne` and `throne-bot` herdr sessions by name
```

- **Server**: `conduwuit`, a pinned OCI image, bound to the tailnet only,
  federation off, token-gated registration.
- **Bridge**: one daemon per bot, built on `matrix-bot-sdk`. It syncs the
  bot's room, formats every inbound message as `<sender> said: <text>`, and
  delivers it through the throne's existing per-pane delivery path into the
  bot's own Claude Code pane. Attachments are downloaded to
  `~/.throne-bot/data/<bot-name>/inbox/<eventId>.<ext>` and the local path is
  appended to the delivered text. Replaying the same event delivers exactly
  once.
- **CLI** (`bin/throne-bot`): `say`, `send-file`, `register-bot`,
  `list-bots`, `lint-objective`.
- **Bot panes**: a separate herdr session named `throne-bot` (never the
  `throne` session) runs one pane per registered bot, launched via the
  vendored `bin/claudey` with model `claude/fable` and the bot's persona
  passed as `--append-system-prompt`. Each pane is renamed to exactly the
  bot's name.
- **Cross-session messaging**: `throne send-agent` and
  `throne agent-statuses` resolve names across both the `throne` and
  `throne-bot` herdr sessions, so an Alpha in the `throne` session can
  address a bot by name. A name collision across sessions is a hard error.

A bot behaves like a Stager toward the one live throne: it consolidates what
its room asks for, files it with `throne add-to-queue` (role `Bot`), and
every objective it files ends with a mandatory final step,
`throne send-agent <bot-name> "DONE <code>: <summary>"`, so the bot can relay
completion back into its room via `throne-bot say`. A bot never spawns
agents and never mutates throne state beyond `add-to-queue` and
`send-agent`.

## Media retention — an honesty note

A periodic sweep deletes media files under
`~/.throne-bot/data/<bot-name>/inbox/` older than 30 days. This is a
file-age sweep run on a timer, not a Matrix server feature: conduwuit itself
does not trim uploaded media, and Matrix's client-server API does not offer
server-enforced retention. If the sweep is disabled or fails, old media
persists on disk indefinitely.

## Adding a new bot

1. Copy `bots.example/electronics-expert/` into `bots/<name>/`.
2. Edit `bots/<name>/bot.json` and `bots/<name>/persona.md` for the new
   bot's identity, room title, and available skills.
3. Register and launch the bot with `install-throne-bot.sh` (re-run is
   idempotent and picks up new bot folders), or register just the one bot
   with `throne-bot register-bot <name>`.

`bots/` is gitignored and excluded from `publish.sh`: it holds live
credentials (`credentials.json`) and must never leave this checkout. Only
`bots.example/` is tracked.

## Linux only

The conduwuit server, `install-throne-bot.sh`, and every systemd unit here
target Linux/systemd exclusively, which is this repository's target
deployment. No macOS/launchd analogue exists for the conduwuit server units:
building one untested would not be the smallest implementation that fulfills
the promise, so it is left for a future contributor rather than shipped
without a real machine to verify it against.
