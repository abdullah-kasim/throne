#!/usr/bin/env bash
#
# uninstall.sh — take the throne back down.
#
# Stops and removes every service the throne installed (systemd --user units
# on linux, LaunchAgents on macOS), the `throne` command shim, the rendered
# Codex hook registration, and the vendored harnesses. IDEMPOTENT: each removal checks first, so running it twice (or on
# a machine that was never fully installed) is quiet and successful.
#
# NEVER TOUCHES YOUR DATA. These survive every mode:
#   config.user.ts, src/config.user.ts   your persona/steering/ntfy secrets
#   ~/.throne/                           agent ledgers and campaign worktrees
#   the git checkout itself               including uncommitted work
#
# Stopping the herdr server (herdr-server.service, or its renamed successor
# throne-herdr.service — this script guards both names during the rename
# transition, see HERDR_UNIT_NAMES below) drops every live agent pane. Panes
# are not recoverable; the worktrees under ~/.throne/worktrees/ are untouched.
#
# --yes only skips the "nothing is live, ok to proceed?" nicety. It is NOT a
# license to kill a live court: if any agent-statuses row is LIVE, teardown
# refuses unconditionally unless --force-live-agents is also given. This is
# deliberate — a flag any automation can pass by rote (--yes) must never be
# the only thing standing between a script and a running campaign.
#
# RUN BY AN AGENT, NOT BY HAND, for the same reason install.sh is: refuses
# without I_AM_AN_AGENT=1 (scripts/require-agent.sh). An agent reads a
# failed teardown step, fixes it, and re-runs; a human stops at the first
# error.

set -euo pipefail

THRONE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd "$THRONE_ROOT"

PURGE=0
ASSUME_YES=0
FORCE_LIVE_AGENTS=0

usage() {
    cat <<'EOF'
usage: ./uninstall.sh [--purge] [--yes] [--force-live-agents] [--help]

  --purge               Also remove the build output and node dependencies
                         (dist/, node_modules/) and the throne's feature-flag
                         file. Leaves your config.user.ts, ~/.throne/ ledgers
                         and worktrees alone.
  --yes                 Do not prompt when the herdr server (herdr-server.service
                         or throne-herdr.service, whichever is installed) is
                         running but no agent is LIVE. Never bypasses a
                         live-court refusal — see --force-live-agents.
  --force-live-agents   Stop the herdr server even though live agent panes were
                         detected. THIS DROPS EVERY LIVE PANE. Required in
                         addition to --yes (or the interactive prompt) any
                         time agent-statuses reports a LIVE row.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --purge)              PURGE=1 ;;
        -y|--yes)              ASSUME_YES=1 ;;
        --force-live-agents)   FORCE_LIVE_AGENTS=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "uninstall.sh: unknown argument \"$1\"" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

# shellcheck source=scripts/require-agent.sh
. "$THRONE_ROOT/scripts/require-agent.sh"
throne_require_agent uninstall.sh

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
did()  { printf '    \033[33m-\033[0m %s\n' "$*"; }
warn() { printf '    \033[31m!\033[0m %s\n' "$*" >&2; }

UNITS=(
    herdr-server.service
    throne-herdr.service
    ntfy.service
    # throne-build.service is retired (BCL campaign, 2026-08-14): its
    # watch-rebuild role collapsed into throne-backend.service's own
    # SelfRebuildHostedWorker. Kept in this list ONLY so a box that installed
    # it before the collapse still gets it torn down cleanly by uninstall.sh;
    # `install-services` itself never installs or enables it again.
    throne-build.service
    throne-backend.service
    throne-keep-going.timer
    throne-keep-going.service
    throne-no-idling.timer
    throne-no-idling.service
    throne-work.service
)

have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d "$HOME/.config/systemd/user" ]; }
have_launchd() { [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; }

# The macOS counterparts of UNITS, by launchd label: the live pair plus every
# retired agent a pre-consolidation mac may still have loaded. Plists live at
# ~/Library/LaunchAgents/<label>.plist.
LAUNCHD_LABELS=(
    com.throne.herdr-server
    com.throne.throne-herdr
    com.throne.ntfy
    com.throne.keep-going
    com.throne.no-idling
    com.throne.throne-backend
)
launchd_domain="gui/$(id -u)"

# --- live agents ----------------------------------------------------------
#
# The herdr terminal-workspace server is guarded under BOTH its legacy name
# (herdr-server.service) and its consolidated name (throne-herdr.service)
# during the rename transition window (see throne-herdr.service's own
# header). Exactly one of the two is ever the live, enabled unit at a time —
# never both — but this guard does not assume which: it checks both names and
# treats either one being active as "the herdr server is live", so the
# live-court refusal below keeps firing across the cutover regardless of
# which name is currently installed. Once the rename has fully landed and the
# legacy name is retired court-wide, HERDR_UNIT_NAMES drops back to a single
# entry — never sooner, or a mid-transition box silently loses this guard.
HERDR_UNIT_NAMES=(herdr-server.service throne-herdr.service)

herdr_server_active=0
herdr_active_unit=""
if have_systemd; then
    for candidate in "${HERDR_UNIT_NAMES[@]}"; do
        if systemctl --user is-active --quiet "$candidate" 2>/dev/null; then
            herdr_server_active=1
            herdr_active_unit="$candidate"
            break
        fi
    done
elif have_launchd; then
    # Same guard, launchd grammar: a loaded agent is a running server.
    for candidate in com.throne.herdr-server com.throne.throne-herdr; do
        if launchctl print "$launchd_domain/$candidate" >/dev/null 2>&1; then
            herdr_server_active=1
            herdr_active_unit="$candidate"
            break
        fi
    done
fi

# FAIL CLOSED: start from "assume live" and only clear that to "confirmed
# empty" on a POSITIVE, successful zero-agent reading. Any failure to get
# that reading — missing dist/ (a prior aborted --purge does exactly this),
# node absent from PATH (happened after this morning's reboot), or
# agent-statuses erroring — must be treated as live, not as safe-to-proceed.
# A safety net that reports "all clear" the moment its own sensor breaks is
# no safety net at all.
live_agent_count=0
live_confirmed_empty=0
statuses_output=""
detection_source=""

if [ "$herdr_server_active" -eq 1 ]; then
    # Primary: ask herdr's own server directly for its pane list. This does
    # NOT depend on dist/ (which --purge deletes) or on throne's own name
    # mapping (which the 13:42 incident proved can desync from real panes) —
    # it is the closest thing to ground truth available cheaply.
    session_name="${THRONE_HERDR_SESSION_NAME_OVERRIDE:-throne}"
    herdr_panes=""
    if command -v herdr >/dev/null 2>&1; then
        if herdr_panes=$(herdr --session "$session_name" pane list 2>/dev/null); then
            live_agent_count=$(printf '%s' "$herdr_panes" | { grep -o '"agent":"[^"]*"' || true; } | wc -l | tr -d ' ')
            live_confirmed_empty=1
            [ "$live_agent_count" -gt 0 ] && live_confirmed_empty=0
            detection_source="herdr pane list"
        fi
    fi

    # Fallback, display-and-gate: throne's own roster, only trusted when the
    # primary probe above could not run at all.
    if [ -z "$detection_source" ] && { [ -x dist/src/tools.js ] || [ -f dist/src/tools.js ]; } && command -v node >/dev/null 2>&1; then
        if statuses_output=$(node ./dist/src/tools.js agent-statuses 2>/dev/null); then
            live_agent_count=$(printf '%s\n' "$statuses_output" | grep -c '  LIVE  ' || true)
            live_confirmed_empty=1
            [ "$live_agent_count" -gt 0 ] && live_confirmed_empty=0
            detection_source="agent-statuses (fallback; herdr pane list unavailable)"
        fi
    fi
fi

if [ "$herdr_server_active" -eq 1 ]; then
    step "Live court"
    [ -n "$statuses_output" ] && printf '%s\n' "$statuses_output" | head -12
    if [ -z "$detection_source" ]; then
        warn "could not positively confirm zero live agents (herdr pane list and agent-statuses both unavailable) — treating the court as live"
    fi

    if [ "$live_confirmed_empty" -eq 1 ]; then
        if [ "$ASSUME_YES" -eq 0 ]; then
            printf '\n    %s is running with no live agents (%s). Stop it? [y/N] ' "$herdr_active_unit" "$detection_source"
            read -r reply
            case "$reply" in
                [yY]|[yY][eE][sS]) ;;
                *) echo "    aborted; nothing was changed."; exit 0 ;;
            esac
        fi
    else
        if [ "$FORCE_LIVE_AGENTS" -eq 1 ]; then
            if [ -n "$detection_source" ]; then
                warn "$live_agent_count live agent pane(s) detected ($detection_source) — proceeding anyway (--force-live-agents)"
            else
                warn "live-agent status unconfirmed — proceeding anyway (--force-live-agents)"
            fi
        else
            if [ -n "$detection_source" ]; then
                warn "$live_agent_count live agent pane(s) detected ($detection_source); refusing to stop $herdr_active_unit."
            else
                warn "refusing to stop $herdr_active_unit: live-agent status could not be confirmed."
            fi
            echo "    --yes does not override this. Re-run with --force-live-agents too if you" >&2
            echo "    really mean to risk dropping live panes, or stop the campaign first." >&2
            exit 1
        fi
    fi
fi

# --- systemd units --------------------------------------------------------

step "systemd user units"

if ! have_systemd; then
    ok "no systemd user manager here; nothing to remove"
else
    removed_any=0
    for unit in "${UNITS[@]}"; do
        unit_file="$HOME/.config/systemd/user/$unit"
        installed=0
        [ -f "$unit_file" ] && installed=1

        if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
            systemctl --user stop "$unit" || true
            did "stopped $unit"
        fi
        # `disable` on a static or already-disabled unit is a harmless no-op,
        # but its stderr is noise during a clean re-run.
        systemctl --user disable "$unit" >/dev/null 2>&1 || true

        if [ "$installed" -eq 1 ]; then
            rm -f "$unit_file"
            did "removed $unit"
            removed_any=1
        fi
    done
    [ "$removed_any" -eq 1 ] || ok "no throne units were installed"
    systemctl --user daemon-reload
    systemctl --user reset-failed 2>/dev/null || true
fi

# --- launchd agents (macOS) -----------------------------------------------

if have_launchd; then
    step "launchd agents"
    removed_any=0
    for label in "${LAUNCHD_LABELS[@]}"; do
        plist="$HOME/Library/LaunchAgents/$label.plist"
        if launchctl print "$launchd_domain/$label" >/dev/null 2>&1; then
            launchctl bootout "$launchd_domain/$label" || true
            did "booted out $label"
        fi
        if [ -f "$plist" ]; then
            rm -f "$plist"
            did "removed $plist"
            removed_any=1
        fi
    done
    [ "$removed_any" -eq 1 ] || ok "no throne LaunchAgents were installed"
fi

# --- podman-restart.service (infrastructure, not a throne unit) -----------
#
# Enabled by the throne-backend consolidation so a Redis container survives
# a reboot. This is podman's own stock systemd integration — throne never
# renders or installs its unit file, so it is disabled here (not removed
# from UNITS= above, and its file is never touched) to keep the enable
# revertible per the migration law. It hosts containers, never panes, so it
# carries none of the live-agent risk the block above guards against.

step "podman-restart.service (Redis boot-survival, not a throne service)"

if ! have_systemd; then
    ok "no systemd user manager here; nothing to disable"
elif systemctl --user is-enabled --quiet podman-restart.service 2>/dev/null \
    || systemctl --user is-active --quiet podman-restart.service 2>/dev/null; then
    systemctl --user disable --now podman-restart.service >/dev/null 2>&1 || true
    did "disabled podman-restart.service"
else
    ok "podman-restart.service was not enabled"
fi

# --- command shim and rendered registrations ------------------------------

step "Command shim and registrations"

throne_shim="$HOME/.local/bin/throne"
if [ -L "$throne_shim" ] || [ -f "$throne_shim" ]; then
    rm -f "$throne_shim"
    did "removed $throne_shim"
else
    ok "no throne command shim"
fi

if [ -f "$THRONE_ROOT/.codex/hooks.json" ]; then
    rm -f "$THRONE_ROOT/.codex/hooks.json"
    did "removed rendered .codex/hooks.json"
else
    ok "no rendered Codex hook registration"
fi

# --- downloaded dependencies ----------------------------------------------

step "Downloaded dependencies"

herdr_home="${XDG_DATA_HOME:-$HOME/.local/share}/throne/herdr"
if [ -d "$herdr_home" ]; then
    rm -rf "$herdr_home"
    did "removed vendored herdr ($herdr_home)"
else
    ok "no vendored herdr"
fi

herdr_cache="${XDG_CACHE_HOME:-$HOME/.cache}/throne/herdr"
if [ -d "$herdr_cache" ]; then
    rm -rf "$herdr_cache"
    did "removed herdr download cache"
fi

# The ntfy server is a container (docker or podman); its image is left alone.
for runtime in ${THRONE_CONTAINER_RUNTIME:-} docker podman; do
    if command -v "$runtime" >/dev/null 2>&1 &&
       "$runtime" container inspect throne-ntfy >/dev/null 2>&1; then
        "$runtime" rm -f throne-ntfy >/dev/null 2>&1 || true
        did "removed the throne-ntfy container ($runtime)"
        break
    fi
done

if [ -d "$THRONE_ROOT/vendor" ]; then
    rm -rf "$THRONE_ROOT/vendor"
    did "removed ./vendor (claude, codex, install stamps)"
else
    ok "no vendored harnesses"
fi

# --- purge ----------------------------------------------------------------

step "Build output and node dependencies"

if [ "$PURGE" -eq 0 ]; then
    ok "kept dist/ and node_modules/ (pass --purge to remove)"
else
    for path in dist node_modules; do
        if [ -d "$THRONE_ROOT/$path" ]; then
            rm -rf "${THRONE_ROOT:?}/$path"
            did "removed $path/"
        fi
    done
    flags_file="${XDG_CONFIG_HOME:-$HOME/.config}/throne/features.json"
    if [ -f "$flags_file" ]; then
        rm -f "$flags_file"
        did "removed $flags_file"
    fi
fi

# --- done -----------------------------------------------------------------

step "Done"
cat <<'EOF'
    The throne is uninstalled.

    AGENT: if anything above printed an error you did not fix, fix it and
    re-run ./uninstall.sh (it is idempotent). Then your LAST message to the
    user must be, verbatim:

        The throne is uninstalled. Quit this agent session; run ./install.sh
        from a fresh agent to stand it back up.

    Left deliberately untouched:
      the ntfy image                        docker/podman rmi binwiederhier/ntfy
      config.user.ts / src/config.user.ts   your persona, steering and secrets
      ~/.throne/                            agent ledgers and campaign worktrees
      this git checkout                     including uncommitted work

    Stand it back up with ./install.sh
EOF
