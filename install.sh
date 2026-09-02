#!/usr/bin/env bash
#
# install.sh — stand up a throne on a bare machine.
#
# Takes a fresh `git clone` with no herdr, no claude and no codex on it, and
# leaves a working court: node dependencies installed, the CLI compiled, all
# three harnesses vendored at pinned versions, the throne's services
# installed and running under the host's own service manager — systemd
# --user on linux, launchd (per-user LaunchAgents) on macOS — and a Regent
# on the throne with a Stager beside it (keep-going raises the Regent, the
# Regent's startup hook raises the Stager, both before this script returns).
# Both platforms are proven: linux on the court's own box, macOS on a real
# mac (2026-09-02).
#
# IDEMPOTENT BY CONTRACT. Every step checks the world before changing it and
# prints `ok` when there was nothing to do, so re-running is cheap and safe.
# Run it after every `git pull` — that is the intended way to apply a moved pin.
#
# Everything downloaded lands in gitignored locations:
#   ./vendor/                       claude + codex, pinned by vendor-pins.json
#   ./node_modules/, ./dist/        npm dependencies and the compiled CLI
#   ~/.local/share/throne/herdr/    herdr, pinned and checksum-verified
# herdr sits outside the repo on purpose: campaign worktrees are separate
# checkouts that must all resolve the SAME herdr, and the runtime looks for it
# under XDG_DATA_HOME. Nothing here is ever committed.
#
# ntfy (phone notifications) runs as a container on every host — the pinned
# binwiederhier/ntfy image under whichever runtime is present, docker or
# podman. Nothing else is installed for it.
#
# RUN BY AN AGENT, NOT BY HAND: this script refuses to start without
# I_AM_AN_AGENT=1 (scripts/require-agent.sh). The point is robustness — an
# agent reads whatever breaks on this particular machine, fixes it, and
# re-runs until the install is clean; a human pasting commands stops at the
# first error. The agent's last message is to tell the human to quit the
# agent and run `throne`.
#
# Undo it with ./uninstall.sh.

set -euo pipefail

THRONE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd "$THRONE_ROOT"

VENDOR_DIR="$THRONE_ROOT/vendor"
PINS_FILE="$THRONE_ROOT/vendor-pins.json"
STAMP_DIR="$VENDOR_DIR/.stamps"

WITH_SERVICES=1
FORCE=0

usage() {
    cat <<'EOF'
usage: ./install.sh [--no-services] [--force] [--help]

  --no-services  Install dependencies and harnesses, but do not install or
                 start any service (systemd unit or LaunchAgent). Useful on
                 a build box.
  --force        Redo every step even when it looks already done.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --no-services) WITH_SERVICES=0 ;;
        --force)       FORCE=1 ;;
        -h|--help)     usage; exit 0 ;;
        *) echo "install.sh: unknown argument \"$1\"" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

# shellcheck source=scripts/require-agent.sh
. "$THRONE_ROOT/scripts/require-agent.sh"
throne_require_agent install.sh

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
did()  { printf '    \033[32m+\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31minstall.sh: %s\033[0m\n' "$*" >&2; exit 1; }

# --- preflight ------------------------------------------------------------
# Fail here with an actionable message rather than three steps later with a
# stack trace. These are the things the throne cannot install for itself.

step "Preflight"

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] ||
   { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 3 ]; }; then
    die "bash >= 4.3 required (running ${BASH_VERSION:-unknown}); the launchers use namerefs.
     macOS ships bash 3.2 — install a modern one (brew install bash) and re-run."
fi
ok "bash ${BASH_VERSION%%(*}"

for required in node npm git curl; do
    command -v "$required" >/dev/null 2>&1 ||
        die "\`$required\` is not on PATH; install it and re-run."
done

# GNU coreutils' sha256sum is not on stock macOS (recent releases ship one
# under /sbin, older ones do not); perl's shasum is on every mac. Same output
# shape ("<hex>  <name>"), so every caller below reads it identically.
if command -v sha256sum >/dev/null 2>&1; then
    sha256() { command sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
    sha256() { command shasum -a 256 "$@"; }
else
    die "neither \`sha256sum\` nor \`shasum\` is on PATH; install coreutils or perl and re-run."
fi

os_kernel="$(uname -s)"
case "$os_kernel" in
    Linux)  ok "linux: services go to systemd --user" ;;
    Darwin) ok "macOS: services go to launchd (~/Library/LaunchAgents)" ;;
    *)      die "unsupported platform $os_kernel; the throne runs on linux (systemd --user) and macOS (launchd) only." ;;
esac

# The per-recipient pane mutex (src/shared-policy/recipient-pane-lock.service.ts)
# shells out to `flock`: util-linux on linux, absent from stock macOS. Without
# it EVERY pane write fails with `spawn flock ENOENT`, one queued message at
# a time and never loudly — measured 2026-09-02: the resurrected Regent's
# opening prompt was the first casualty. The discoteq/flock brew formula is
# argument-compatible, so on a mac with brew it is installed here.
if ! command -v flock >/dev/null 2>&1; then
    if [ "$os_kernel" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
        brew install flock
        did "installed flock (brew) — the recipient-pane mutex shells out to it"
    else
        die "\`flock\` is not on PATH; the recipient-pane mutex shells out to it.
     linux: install util-linux. macOS: brew install flock. Then re-run."
    fi
fi
ok "flock: $(command -v flock)"

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 24 ]; then
    die "node >= 24 required (found $(node --version)); the throne relies on
     native TypeScript type stripping and modern test-runner behaviour."
fi
ok "node $(node --version), npm $(npm --version)"

[ -f "$PINS_FILE" ] || die "missing $PINS_FILE — this is not a throne checkout."
ok "pins: $(basename "$PINS_FILE")"

mkdir -p "$VENDOR_DIR" "$STAMP_DIR"

# A stamp records the input that produced a completed step, so the step can be
# skipped only when that exact input is unchanged. `--force` ignores stamps.
stamp_is_current() {
    [ "$FORCE" -eq 0 ] && [ -f "$STAMP_DIR/$1" ] &&
        [ "$(cat "$STAMP_DIR/$1")" = "$2" ]
}
stamp_write() { printf '%s\n' "$2" > "$STAMP_DIR/$1"; }

pin_field() {
    node -e '
      const pins = require(process.argv[1]).harnesses;
      const entry = pins[process.argv[2]];
      if (!entry) { console.error("no pin for " + process.argv[2]); process.exit(1); }
      process.stdout.write(String(entry[process.argv[3]]));
    ' "$PINS_FILE" "$1" "$2"
}
tool_pin_field() {
    node -e '
      const pins = require(process.argv[1]).tools;
      const entry = pins[process.argv[2]];
      if (!entry) { console.error("no tool pin for " + process.argv[2]); process.exit(1); }
      process.stdout.write(String(entry[process.argv[3]]));
    ' "$PINS_FILE" "$1" "$2"
}

# --- ntfy -----------------------------------------------------------------
# ntfy is the throne's self-hosted phone-push server
# (agent_docs/ntfy-phone-notifications.md). It runs as the pinned
# binwiederhier/ntfy image on every host, under whichever OCI runtime the box
# has — docker or podman, detected the same way systemd/ntfy-serve detects it
# (THRONE_CONTAINER_RUNTIME overrides). Upstream ships no macOS server binary
# and brew's mac formula is client-only, so a container is the one shape
# that works everywhere. Tailscale is NOT installed here: ntfy is tailnet-only
# by design and its wrapper waits for a tailnet address, so a missing
# Tailscale is a warning, not a failure.

container_runtime() {
    local candidate
    for candidate in ${THRONE_CONTAINER_RUNTIME:-} docker podman; do
        if command -v "$candidate" >/dev/null 2>&1; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

install_ntfy() {
    ntfy_image=$(tool_pin_field ntfy image)
    runtime=$(container_runtime) ||
        die "no container runtime found (looked for docker, podman); the ntfy server runs as a container.
     Install Docker Desktop / docker-ce or podman, then re-run. Set
     THRONE_CONTAINER_RUNTIME=<name> to force a specific one."
    if ! "$runtime" info >/dev/null 2>&1; then
        ok "$runtime is installed but not reachable (daemon/machine not running); skipped pulling $ntfy_image — the ntfy service pulls on first start and keeps retrying until it is"
    elif "$runtime" image inspect "$ntfy_image" >/dev/null 2>&1; then
        ok "ntfy image $ntfy_image present ($runtime)"
    else
        "$runtime" pull "$ntfy_image"
        did "pulled $ntfy_image with $runtime"
    fi

    if command -v tailscale >/dev/null 2>&1 || [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
        ok "tailscale present; ntfy will bind to the tailnet address"
    else
        ok "tailscale NOT installed — the ntfy service will wait for a tailnet address and keep retrying until you install it (https://tailscale.com/download)"
    fi
}

# --- node dependencies ----------------------------------------------------

step "Node dependencies"

lock_hash=$(sha256 package-lock.json | cut -d' ' -f1)
if [ -d node_modules ] && stamp_is_current npm-deps "$lock_hash"; then
    ok "node_modules matches package-lock.json"
else
    npm ci --no-audit --no-fund
    stamp_write npm-deps "$lock_hash"
    did "installed node dependencies"
fi

# --- compile --------------------------------------------------------------
# Production runs compiled JavaScript from dist/. Node's native type stripping
# does NOT apply the Nest decorator transform, so an uncompiled tree cannot
# serve as production evidence — see CLAUDE.md.

step "Compile"

# One digest over every source path and its contents. Fed to sha256 by a
# read loop, not `xargs -0 sha256`: sha256 is a shell function here and xargs
# cannot call one, so that form only worked on hosts that happened to ship a
# /sbin/sha256 binary and died with exit 127 everywhere else.
src_hash=$(
    find src tsconfig.json tsconfig.build.json nest-cli.json -type f \
        \( -name '*.ts' -o -name '*.json' \) -not -name '*.spec.ts' \
        -not -name '*.test.ts' -print0 2>/dev/null |
        sort -z |
        while IFS= read -r -d '' source_file; do
            printf '%s\0' "$source_file"
            cat "$source_file"
        done | sha256 | cut -d' ' -f1
)
if [ -x dist/src/tools.js ] && stamp_is_current build "$src_hash"; then
    ok "dist/ matches src/"
elif [ -f dist/src/tools.js ] && stamp_is_current build "$src_hash"; then
    ok "dist/ matches src/"
else
    npm run build
    stamp_write build "$src_hash"
    did "compiled the CLI to dist/"
fi

[ -f dist/src/tools.js ] || die "build produced no dist/src/tools.js"

# --- vendored harnesses ---------------------------------------------------
# claude and codex ship as npm packages, so a pinned `npm install --prefix`
# into ./vendor gives an exact, reproducible, self-contained harness that no
# global install can shadow.

step "Harnesses (claude, codex)"

vendor_bin() { printf '%s/node_modules/.bin/%s' "$VENDOR_DIR" "$1"; }

installed_version() {
    local binary="$1"
    [ -x "$binary" ] || return 1
    "$binary" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

harness_specs=()
for harness in claude codex; do
    package=$(pin_field "$harness" package)
    version=$(pin_field "$harness" version)
    harness_specs+=("${package}@${version}")
done

pins_hash=$(printf '%s\n' "${harness_specs[@]}" | sha256 | cut -d' ' -f1)
if stamp_is_current harnesses "$pins_hash" &&
   [ -x "$(vendor_bin claude)" ] && [ -x "$(vendor_bin codex)" ]; then
    ok "vendored harnesses match vendor-pins.json"
else
    # A minimal private manifest keeps npm from walking up into the throne's
    # own package.json and installing the throne's dependencies again.
    [ -f "$VENDOR_DIR/package.json" ] ||
        printf '{ "name": "throne-vendor", "private": true, "version": "0.0.0" }\n' \
            > "$VENDOR_DIR/package.json"
    ( cd "$VENDOR_DIR" && npm install --no-audit --no-fund --save-exact "${harness_specs[@]}" )
    stamp_write harnesses "$pins_hash"
    did "vendored ${harness_specs[*]}"
fi

for harness in claude codex; do
    binary=$(vendor_bin "$harness")
    [ -x "$binary" ] || die "vendored $harness is missing at $binary"
    want=$(pin_field "$harness" version)
    got=$(installed_version "$binary" || true)
    [ "$got" = "$want" ] ||
        die "vendored $harness reports \"${got:-nothing}\", expected $want"
    ok "$harness $got → ${binary#"$THRONE_ROOT"/}"
done

# --- herdr + services -----------------------------------------------------
# `install-services` owns the rest: it downloads and CHECKSUM-VERIFIES the
# pinned herdr, renders every unit template with this throne's absolute path,
# installs the `throne` command shim and the Codex hook registration, retires
# any pre-consolidation unit still lingering on the box, and enables the live
# set (throne-herdr + throne-backend) — `systemctl --user enable --now` on
# linux, `launchctl enable` + `bootstrap` on macOS. It is itself idempotent
# and reports each file as changed or unchanged.

if [ "$WITH_SERVICES" -eq 0 ]; then
    step "Services"
    ok "skipped (--no-services)"
else
    step "Feature flags"

    flags_file="${XDG_CONFIG_HOME:-$HOME/.config}/throne/features.json"
    mkdir -p "$(dirname "$flags_file")"
    desired_flags='{"herdr-decouple": true, "harness-decouple": true}'
    if [ -f "$flags_file" ] && [ "$FORCE" -eq 0 ] &&
       node -e '
         const flags = require(process.argv[1]);
         process.exit(flags["herdr-decouple"] && flags["harness-decouple"] ? 0 : 1);
       ' "$flags_file" 2>/dev/null; then
        ok "decoupling flags already on"
    else
        printf '%s\n' "$desired_flags" > "$flags_file"
        did "enabled herdr-decouple and harness-decouple"
    fi

    step "ntfy (phone notifications)"
    install_ntfy

    step "herdr + services"
    node ./dist/src/tools.js install-services

    # install-services enables and starts the live units itself, but it
    # deliberately never restarts a running herdr — a restart drops every
    # live agent pane, which is an operator decision, not an installer's. So
    # this is a check, not a start: confirm the herdr server is up under the
    # host's service manager and say so either way. A unit that is installed
    # and enabled yet not running is an operator's call (journalctl /
    # ~/Library/Logs/throne will say why), never something to force here.
    if [ "$os_kernel" = "Linux" ]; then
        if systemctl --user is-active --quiet throne-herdr.service 2>/dev/null; then
            ok "throne-herdr.service is running (never restarted here: a restart drops live panes)"
        else
            ok "throne-herdr.service is not running; inspect with: systemctl --user status throne-herdr.service"
        fi
    else
        herdr_target="gui/$(id -u)/com.throne.throne-herdr"
        if launchctl print "$herdr_target" >/dev/null 2>&1; then
            ok "com.throne.throne-herdr is loaded (never kickstarted here: a restart drops live panes)"
        else
            ok "com.throne.throne-herdr is not loaded; inspect with: launchctl print $herdr_target"
        fi
    fi

    step "herdr workspace"

    # A freshly created herdr session has a server but NO workspace, and
    # `tab create` fails with `workspace_not_found` until one exists — which
    # means a brand-new machine could install cleanly and still refuse to spawn
    # a single agent. Creating one here closes that gap without an interactive
    # attach. Idempotent: only ever creates the first one.
    # The pinned herdr lives at a versioned path that moves with every pin
    # bump in src/install-services/herdr-release.service.ts. Ask the compiled
    # pin where that is instead of hardcoding a tag here and silently
    # skipping this step the first time the pin moves (which is exactly what
    # a stale literal v0.8.0 did against the v0.8.2 pin).
    herdr_bin=$(node -e '
      import("./dist/src/install-services/herdr-release.service.js")
        .then((m) => process.stdout.write(m.ownedHerdrExecutablePath()));
    ')
    if [ ! -x "$herdr_bin" ]; then
        ok "herdr not installed here; skipping workspace check"
    else
        # install-services bootstrapped the herdr server moments ago and it
        # may still be binding its socket, so poll for a few seconds before
        # declaring the list unreadable. The list is captured on its own,
        # NOT piped into the parser with a `|| echo unknown` tail: under
        # pipefail a failed herdr made both the parser and the tail print,
        # yielding "unknownunknown", which matched no case and was reported
        # as "already present" while the box had no workspace at all.
        workspace_count=unknown
        for _attempt in 1 2 3 4 5 6 7 8 9 10; do
            if workspace_list=$("$herdr_bin" --session throne workspace list 2>/dev/null); then
                workspace_count=$(printf '%s' "$workspace_list" | node -e '
                  let raw = "";
                  process.stdin.on("data", (chunk) => { raw += chunk; });
                  process.stdin.on("end", () => {
                    try {
                      const list = JSON.parse(raw).result?.workspaces ?? [];
                      process.stdout.write(String(list.length));
                    } catch { process.stdout.write("unknown"); }
                  });
                ') || workspace_count=unknown
                break
            fi
            sleep 1
        done
        case "$workspace_count" in
            0)
                "$herdr_bin" --session throne workspace create \
                    --label throne --cwd "$THRONE_ROOT" >/dev/null &&
                    did "created the throne workspace (agents cannot spawn without one)"
                ;;
            unknown)
                ok "could not read the workspace list (herdr not answering); leaving it alone"
                ;;
            *)
                ok "$workspace_count workspace(s) already present"
                ;;
        esac
    fi

    # --- Regent + Stager ---------------------------------------------------
    # A court with nobody on the throne is not installed. throne-backend's
    # keep-going worker does resurrect a missing Regent, but only on its
    # 30-minute cron boundary (`0 */30 * * * *`, no run-on-start), so a fresh
    # box sat headless for up to half an hour — the Lord's order (2026-09-02):
    # keep-going is part of the install. It is the same heartbeat the cron
    # runs: it honours a `dismissed` desired-state, nudges a live Regent with
    # the queue literal, or enqueues a resurrection that throne-backend's
    # queue drain spawns within a second. A Regent THIS run raised then gets
    # its install order by send-agent; one that was already live got
    # keep-going's ordinary nudge and needs nothing more.
    #
    # The Stager is raised by the Regent's own SessionStart hook
    # (throne-startup → ensureLiveStager). This step waits for that, and if
    # the hook did not deliver, applies the same floor directly — the court
    # must have a Stager before the installer returns.

    step "Regent + Stager"

    # One probe over the compiled runtime, six lines: desired-state, whether
    # a Regent is live (live|-|?), the Stager-floor decision (present <name>
    # | ensure | stay-down | refuse <reason>), the Regent's canonical name,
    # and the persona titles the install order is written in.
    court_probe() {
        node --input-type=module -e '
          const rs = await import("./dist/src/regent-state/regent-state.service.js");
          const roster = await import("./dist/src/agent-statuses/agent-statuses-roster.js");
          const floor = await import("./dist/src/alpha-autoscale/stager-floor.js");
          const { PERSONA_CONFIG } = await import("./dist/src/application-config.service.js");
          const desired = await rs.readDesiredState();
          let regent = "-";
          try { regent = (await rs.findLiveRegent()) === null ? "-" : "live"; } catch { regent = "?"; }
          const decision = floor.decideStagerFloorAction(desired, await roster.getAgentStatusesRoster());
          const stager = decision.action === "present" ? `present ${decision.name}`
            : decision.action === "refuse" ? `refuse ${decision.reason}` : decision.action;
          process.stdout.write([desired, regent, stager, rs.REGENT_NAME,
            PERSONA_CONFIG.tierTitles.regent, PERSONA_CONFIG.addressTitle].join("\n") + "\n");
        ' 2>/dev/null
    }
    read_probe() {
        local probe
        probe=$(court_probe) || return 1
        desired_state=$(printf '%s\n' "$probe" | sed -n 1p)
        regent_live=$(printf '%s\n' "$probe" | sed -n 2p)
        stager_state=$(printf '%s\n' "$probe" | sed -n 3p)
        regent_name=$(printf '%s\n' "$probe" | sed -n 4p)
        regent_title=$(printf '%s\n' "$probe" | sed -n 5p)
        lord_title=$(printf '%s\n' "$probe" | sed -n 6p)
    }
    # Runs a CLI command, printing its output indented and without node's
    # SQLite experimental-warning noise; returns the command's exit status.
    court_cli() {
        local output status
        output=$(node ./dist/src/tools.js "$@" 2>&1) && status=0 || status=$?
        printf '%s\n' "$output" | grep -vE 'ExperimentalWarning|--trace-warnings' |
            sed '/^$/d; s/^/      /'
        return "$status"
    }

    read_probe || die "could not probe the court through dist/; run: node ./dist/src/tools.js agent-statuses"

    if [ "$desired_state" = "dismissed" ]; then
        ok "Regent desired-state is dismissed — the court stays down (summon-regent stands it back up)"
    else
        regent_was_live=$regent_live
        court_cli keep-going || die "keep-going failed; fix the error above and re-run"

        if [ "$regent_was_live" = "live" ]; then
            ok "$regent_name already live; keep-going gave it the ordinary queue nudge (verdict above)"
        else
            did "asked throne-backend to resurrect the $regent_name (keep-going)"
            waited=0
            while [ "$waited" -lt 120 ]; do
                read_probe || true
                [ "$regent_live" = "live" ] && break
                sleep 2
                waited=$((waited + 2))
            done
            if [ "$regent_live" != "live" ]; then
                warn "no live $regent_name after ${waited}s; inspect the throne-backend log (linux: journalctl --user -u throne-backend; macOS: ~/Library/Logs/throne/throne-backend.log)"
            else
                did "$regent_name is live (after ${waited}s)"
                install_order="install.sh just stood up this throne on $(hostname) and resurrected you as its ${regent_title}. Begin the court's startup now: read AGENTS.md, run \`npm start -- consume-fence-handoff-on-start\`, run render-queue, run \`./bin/throne-cli agent-statuses\` and confirm a live Stager (your SessionStart hook raises one; say so in your report if none is live), reconcile any in-flight work, and start dispatching queued objectives. Report outcomes to the ${lord_title}; never put questions to him."
                if court_cli send-agent "$regent_name" "$install_order" --sender-name install; then
                    did "sent the $regent_name its install order (send-agent)"
                else
                    warn "could not send the $regent_name its install order; it still boots on its own opening prompt"
                fi
            fi
        fi

        # The Stager: wait for the Regent's startup hook to raise one.
        waited=0
        while [ "$waited" -lt 180 ]; do
            read_probe || true
            case "$stager_state" in present*|stay-down|refuse*) break ;; esac
            sleep 3
            waited=$((waited + 3))
        done
        case "$stager_state" in
            present*)
                ok "Stager live: ${stager_state#present }"
                ;;
            stay-down)
                ok "Stager floor stays down (desired-state dismissed)"
                ;;
            refuse*)
                warn "Stager floor refused: ${stager_state#refuse }"
                ;;
            *)
                # The hook did not deliver within the wait; apply the floor here.
                node --input-type=module -e '
                  const floor = await import("./dist/src/alpha-autoscale/stager-floor.js");
                  const decision = await floor.ensureLiveStager();
                  process.stdout.write(`      stager-floor: ${JSON.stringify(decision)}\n`);
                ' 2>&1 | grep -vE 'ExperimentalWarning|--trace-warnings' || true
                read_probe || true
                case "$stager_state" in
                    present*) did "raised the Stager directly: ${stager_state#present } (the $regent_name's startup hook had not within ${waited}s)" ;;
                    *)        warn "no live Stager after ${waited}s and a direct floor pass (state: $stager_state); inspect: node ./dist/src/tools.js agent-statuses" ;;
                esac
                ;;
        esac
    fi
fi

# --- done -----------------------------------------------------------------

step "Done"
cat <<EOF
    The throne stands at $THRONE_ROOT

    AGENT: the install is complete. If anything above printed an error or a
    non-"ok" line you did not fix, fix it and re-run ./install.sh first (it
    is idempotent). Then your LAST message to the user must be, verbatim:

        The throne is installed. Quit this agent session and run \`throne\`
        in a fresh terminal.

    ./bin/claude      Claude Code in yolo mode, on the vendored pin
    ./bin/codex       Codex in yolo mode, on the vendored pin
    ./bin/throne-cli  the court's command surface
    ./bin/throne      open/attach the throne herdr session

    Services: throne-herdr (the herdr server), throne-backend (the cron
    host) and ntfy (phone notifications, tailnet-only). The court itself
    is up too: node ./dist/src/tools.js agent-statuses lists the Regent
    and the Stager.
    linux: systemctl --user status throne-herdr throne-backend ntfy
    macOS: launchctl print gui/\$(id -u)/com.throne.throne-herdr
           logs under ~/Library/Logs/throne/

    Re-run ./install.sh after any git pull; it is idempotent.
    Remove everything with ./uninstall.sh.
EOF
