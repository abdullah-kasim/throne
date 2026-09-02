#!/usr/bin/env bash
#
# rnp-herdr-cutover.sh — flip the live herdr terminal-workspace server from
# its legacy unit name (herdr-server.service) to its consolidated name
# (throne-herdr.service). See agent_docs/rnp-herdr-rename-runbook.md for the
# full context, preconditions, and evidence this was rehearsed against.
#
# THIS DROPS EVERY LIVE AGENT PANE, including whichever pane runs this
# script if it is executed inline. Because of that it MUST be launched
# detached (systemd-run --user, below) so it keeps running and completes
# after its own launching pane dies with herdr-server. Do not source or
# `bash` this file directly from a live agent pane — use the systemd-run
# invocation documented in the runbook.
#
# LIVE-AGENT GUARD (Regent order, 2026-08-12, EVD precedent): "the caller
# will remember the precondition" is a known failure mode in this court, not
# a design — EVD (fd76d55) exists precisely because that shape failed even
# when the instruction was explicit and correctly understood. So this script
# does not trust its caller to have checked agent-statuses first: it checks
# itself, refuses when any agent is LIVE, and prints every name it is about
# to kill before doing anything destructive. --force overrides, loudly,
# naming every agent about to die — the same shape EVD gave reap-agent
# --force, for court-wide consistency.
#
# Detection order, same reasoning as uninstall.sh's live-court guard:
#   1. `herdr --session throne pane list` — independent of dist/ being
#      current and of throne's own name mapping, since this runs while
#      things are being torn down and dist/ or the ledger could be stale or
#      gone. Only reports that N agent-bearing panes exist, not throne
#      registry names (the raw pane list carries no throne agent name) — so
#      when this is the ONLY probe that answers, the printed identifiers are
#      best-effort (pane id / cwd), not authoritative throne names.
#   2. `agent-statuses` (via dist/src/tools.js) — richer, gives real
#      registered throne names, but depends on dist/ and the ledger being
#      intact, so it is the fallback, not the primary.
#   FAIL CLOSED: if NEITHER probe can run, this refuses. A safety net that
#   reports "all clear" the moment its own sensor breaks is no safety net at
#   all (uninstall.sh's own guard failed OPEN four separate ways before that
#   was fixed — see agent_docs UNS finding — and this does not repeat it).

set -euo pipefail

FORCE=0
THRONE_ROOT_OVERRIDE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=1 ;;
        --throne-root) THRONE_ROOT_OVERRIDE="$2"; shift ;;
        -h|--help)
            echo "usage: $0 [--force] [--throne-root <path>]"
            echo "  --force  proceed even though live agents were detected (LOUD-WARNS naming each one first)"
            exit 0
            ;;
        *) echo "$0: unknown argument \"$1\"" >&2; exit 2 ;;
    esac
    shift
done

log() { printf '[rnp-cutover] %s %s\n' "$(date -Is)" "$*"; }
warn() { printf '[rnp-cutover] \033[31m!\033[0m %s %s\n' "$(date -Is)" "$*" >&2; }

# --- live-agent detection --------------------------------------------------

live_agent_names=()
detection_source=""
probe_succeeded=0

session_name="${THRONE_HERDR_SESSION_NAME_OVERRIDE:-throne}"
if command -v herdr >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    if herdr_panes=$(herdr --session "$session_name" pane list 2>/dev/null); then
        # Every pane object carrying a top-level "agent" field is a live
        # agent-bearing pane. The raw pane list has no throne registry name,
        # so identify each hit by its pane_id — best-effort, not an
        # authoritative throne name. Parsed with `node -e` (real JSON.parse)
        # rather than grep/sed: pane objects nest a second "agent" key inside
        # "agent_session", which broke a naive brace-split/regex approach —
        # only real JSON parsing distinguishes the top-level field reliably.
        # The node script exits nonzero on any parse failure so a malformed
        # response is never mistaken for "zero panes" (fail closed, not open).
        parsed_panes=""
        parse_rc=0
        parsed_panes=$(printf '%s' "$herdr_panes" | node -e '
            let raw = "";
            process.stdin.on("data", c => raw += c);
            process.stdin.on("end", () => {
                let panes;
                try { panes = JSON.parse(raw).result.panes; } catch { process.exit(1); }
                if (!Array.isArray(panes)) process.exit(1);
                for (const p of panes) if (p && typeof p.agent === "string") console.log(p.pane_id || "unknown");
            });
        ' 2>/dev/null) && parse_rc=0 || parse_rc=$?

        if [ "$parse_rc" -eq 0 ]; then
            probe_succeeded=1
            detection_source="herdr pane list"
            while IFS= read -r pane_id; do
                [ -n "$pane_id" ] && live_agent_names+=("pane:$pane_id")
            done <<< "$parsed_panes"
        fi
    fi
fi

# Fallback: throne's own registry, richer (real names), only trusted when the
# primary probe above could not run at all.
if [ "$probe_succeeded" -eq 0 ]; then
    throne_root="${THRONE_ROOT_OVERRIDE:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)}"
    if { [ -x "$throne_root/dist/src/tools.js" ] || [ -f "$throne_root/dist/src/tools.js" ]; } && command -v node >/dev/null 2>&1; then
        if statuses_output=$(node "$throne_root/dist/src/tools.js" agent-statuses 2>/dev/null); then
            probe_succeeded=1
            detection_source="agent-statuses (fallback; herdr pane list unavailable)"
            while IFS= read -r name; do
                [ -n "$name" ] && live_agent_names+=("$name")
            done < <(printf '%s\n' "$statuses_output" \
                | grep '  LIVE  ' \
                | awk '{gsub(/\*$/, "", $1); print $1}')
        fi
    fi
fi

if [ "$probe_succeeded" -eq 0 ]; then
    warn "could not positively confirm the court's agent state (herdr pane list and agent-statuses both unavailable) — REFUSING (fail closed)."
    warn "this is not overridable by --force: --force only waives a CONFIRMED live-agent finding, never an unconfirmed one."
    exit 1
fi

if [ "${#live_agent_names[@]}" -gt 0 ]; then
    warn "${#live_agent_names[@]} live agent(s) detected via $detection_source:"
    for n in "${live_agent_names[@]}"; do
        warn "  - $n"
    done
    if [ "$FORCE" -eq 1 ]; then
        warn "--force given — PROCEEDING ANYWAY. EVERY AGENT LISTED ABOVE IS ABOUT TO DIE:"
        for n in "${live_agent_names[@]}"; do
            warn "  KILLING: $n"
        done
    else
        warn "refusing to cut over: the court is not empty."
        warn "empty the court first (let campaigns land or park them), or pass --force to proceed anyway"
        warn "(this drops every pane named above — there is no undo for a dropped pane)."
        exit 1
    fi
else
    log "$detection_source confirms zero live agents — court is empty, proceeding."
fi

# --- cutover ----------------------------------------------------------------

log "stopping herdr-server.service"
systemctl --user stop herdr-server.service

log "disabling herdr-server.service"
systemctl --user disable herdr-server.service

log "enabling+starting throne-herdr.service"
systemctl --user enable --now throne-herdr.service

log "done — throne-herdr.service is now the live herdr server"
log "every agent pane, including the Regent, is now dead."
log "resurrection is throne-backend's keep-going cron (EVERY_30_MINUTES, so :00/:30 marks) — up to a 30-minute gap."
log "to resurrect sooner: once throne-herdr.service is confirmed active, run (from a non-pane shell, e.g. ssh/tty):"
log "  node <throne root>/dist/src/tools.js keep-going"
