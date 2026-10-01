#!/usr/bin/env bash

set -euo pipefail

THRONE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd "$THRONE_ROOT"

STAMP_DIR="$THRONE_ROOT/vendor/.stamps"
FORCE=0

usage() {
    cat <<'EOF'
usage: ./install-throne-bot.sh [--force] [--help]

  --force  Redo every step even when it looks already done.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --force)   FORCE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "install-throne-bot.sh: unknown argument \"$1\"" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

. "$THRONE_ROOT/scripts/require-agent.sh"
throne_require_agent install-throne-bot.sh

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
did()  { printf '    \033[32m+\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31minstall-throne-bot.sh: %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$STAMP_DIR"
stamp_is_current() {
    [ "$FORCE" -eq 0 ] && [ -f "$STAMP_DIR/$1" ] &&
        [ "$(cat "$STAMP_DIR/$1")" = "$2" ]
}
stamp_write() { printf '%s\n' "$2" > "$STAMP_DIR/$1"; }

step "Preflight"

command -v node >/dev/null 2>&1 || die "\`node\` is not on PATH; run ./install.sh first."
ok "node $(node --version)"

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
RUNTIME=$(container_runtime) ||
    die "no container runtime found (looked for docker, podman); conduwuit runs as a container.
     Install Docker Desktop / docker-ce or podman, then re-run. Set
     THRONE_CONTAINER_RUNTIME=<name> to force a specific one."
ok "container runtime: $RUNTIME"

command -v tailscale >/dev/null 2>&1 ||
    die "\`tailscale\` is not on PATH; conduwuit and the bot bridges are tailnet-only.
     Install it (https://tailscale.com/download) and re-run."
ok "tailscale: $(command -v tailscale)"

herdr_bin=$(node -e '
  import("./dist/src/install-services/herdr-release.service.js")
    .then((m) => process.stdout.write(m.ownedHerdrExecutablePath()));
')
[ -x "$herdr_bin" ] ||
    die "no herdr binary at $herdr_bin; run ./install.sh first."
ok "herdr: $herdr_bin"

[ -f dist/src/tools.js ] || die "no dist/src/tools.js; run ./install.sh (or npm run build) first."
[ -x bin/claudey ] || die "no bin/claudey; this is not a throne checkout."

step "conduwuit image"

conduwuit_image=$(node -e '
  process.stdout.write(require(process.argv[1]).tools.conduwuit.image);
' "$THRONE_ROOT/vendor-pins.json")

if "$RUNTIME" image inspect "$conduwuit_image" >/dev/null 2>&1; then
    ok "conduwuit image $conduwuit_image present ($RUNTIME)"
else
    "$RUNTIME" pull "$conduwuit_image"
    did "pulled $conduwuit_image with $RUNTIME"
fi

step "install-services (throne-bot-herdr.service, throne-bot-bridge@.service, conduwuit units)"

node ./dist/src/tools.js install-services

step "throne-bot herdr session"

if systemctl --user is-active --quiet throne-bot-herdr.service 2>/dev/null; then
    ok "throne-bot-herdr.service already running"
else
    systemctl --user start throne-bot-herdr.service
    did "started throne-bot-herdr.service"
fi

step "conduwuit readiness"

tailnet_wait_attempts="${THRONE_BOT_TAILNET_WAIT_ATTEMPTS:-60}"
tailnet_ip=""
for _attempt in $(seq 1 "$tailnet_wait_attempts"); do
    tailnet_ip=$(tailscale ip -4 2>/dev/null || true)
    case "$tailnet_ip" in
        ''|*[!0-9.]*) tailnet_ip="" ;;
        *) break ;;
    esac
    sleep 1
done
[ -n "$tailnet_ip" ] || die "no tailnet IPv4 address after ${tailnet_wait_attempts}s; is tailscale up? (tailscale status)"

conduwuit_base_url="http://${tailnet_ip}:8448"
conduwuit_ready_attempts="${THRONE_BOT_CONDUWUIT_READY_ATTEMPTS:-60}"
ready=0
for _attempt in $(seq 1 "$conduwuit_ready_attempts"); do
    if curl -fsS "${conduwuit_base_url}/_matrix/client/versions" >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 1
done
[ "$ready" -eq 1 ] ||
    die "conduwuit did not answer ${conduwuit_base_url}/_matrix/client/versions after ${conduwuit_ready_attempts}s; inspect: systemctl --user status conduwuit.service"
ok "conduwuit answers at $conduwuit_base_url"

registration_token_file="${XDG_STATE_HOME:-$HOME/.local/state}/conduwuit/registration-token"
[ -s "$registration_token_file" ] ||
    die "no registration token at $registration_token_file; conduwuit has not written one yet"
registration_token=$(cat "$registration_token_file")

export THRONE_BOT_HOMESERVER_URL="$conduwuit_base_url"
export THRONE_BOT_REGISTRATION_TOKEN="$registration_token"

step "Registering bots"

registered_bots=()
if [ -d "$THRONE_ROOT/bots" ]; then
    for bot_dir in "$THRONE_ROOT"/bots/*/; do
        [ -f "${bot_dir}bot.json" ] || continue
        bot_name=$(basename "$bot_dir")
        if [ -f "${bot_dir}credentials.json" ]; then
            ok "$bot_name already registered"
        else
            bin/throne-bot register-bot "$bot_name" >/dev/null
            did "registered bot $bot_name"
        fi
        registered_bots+=("$bot_name")
    done
fi
if [ "${#registered_bots[@]}" -eq 0 ]; then
    ok "no bots/*/bot.json present; nothing to register (copy bots.example/<name>/ into bots/<name>/ and edit it)"
fi

step "Bot panes"

if [ "${#registered_bots[@]}" -gt 0 ]; then
    pane_launch_script=$(mktemp "${TMPDIR:-/tmp}/throne-bot-pane-launch.XXXXXX.mjs")
    trap 'rm -f "$pane_launch_script"' EXIT
    cat > "$pane_launch_script" <<'JS'
const [, , throneRoot, ...botNames] = process.argv;
const { runHerdr } = await import(`${throneRoot}/dist/src/herdr/herdr-client.js`);
const { createHerdrTab } = await import(`${throneRoot}/dist/src/herdr/herdr-tab.service.js`);
const { startInTab } = await import(`${throneRoot}/dist/src/herdr/herdr-launch.js`);
const { loadBotConfig } = await import(`${throneRoot}/dist/src/throne-bot/bot-config.js`);
const { renderBotSystemPrompt } = await import(`${throneRoot}/dist/src/throne-bot/prompt/bot-system-prompt.js`);
const path = await import('node:path');

const { stdout } = await runHerdr(['agent', 'list']);
const liveNames = new Set(
  JSON.parse(stdout).result.agents.map((agent) => agent.name),
);

const { stdout: workspaceListStdout } = await runHerdr(['workspace', 'list']);
const workspaces = JSON.parse(workspaceListStdout).result.workspaces;
if (workspaces.length === 0) {
  await runHerdr(['workspace', 'create', '--label', 'main']);
}

for (const botName of botNames) {
  if (liveNames.has(botName)) {
    process.stdout.write(`ok:${botName}\n`);
    continue;
  }
  const botDir = path.join(throneRoot, 'bots', botName);
  const config = await loadBotConfig(botDir);
  const systemPrompt = await renderBotSystemPrompt(config);
  const { rootPaneId } = await createHerdrTab(botName, throneRoot);
  await startInTab(botName, rootPaneId, {
    cwd: throneRoot,
    argv: ['claudey', '--model', config.model, '--append-system-prompt', systemPrompt],
    tabLabel: botName,
  });
  process.stdout.write(`launched:${botName}\n`);
}
JS
    THRONE_HERDR_SESSION_NAME_OVERRIDE=throne-bot \
        node "$pane_launch_script" "$THRONE_ROOT" "${registered_bots[@]}" |
        while IFS=: read -r verb name; do
            case "$verb" in
                ok)       ok "pane for $name already live" ;;
                launched) did "launched pane for $name" ;;
            esac
        done
    rm -f "$pane_launch_script"
    trap - EXIT
fi

step "Bot bridges"

for bot_name in "${registered_bots[@]:-}"; do
    [ -n "$bot_name" ] || continue
    unit="throne-bot-bridge@${bot_name}.service"
    if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
        ok "$unit already running"
    else
        systemctl --user start "$unit"
        did "started $unit"
    fi
done

step "Done"
cat <<EOF
    throne-bot stands alongside the throne at $THRONE_ROOT

    Matrix homeserver: $conduwuit_base_url (tailnet-only)
    herdr session:     throne-bot ($herdr_bin --session throne-bot ...)
    Bots registered:   ${#registered_bots[@]}

    Re-run ./install-throne-bot.sh after any git pull or after adding a new
    bots/<name>/; it is idempotent.
EOF
