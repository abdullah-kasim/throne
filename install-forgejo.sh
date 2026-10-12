#!/usr/bin/env bash

set -euo pipefail

THRONE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd "$THRONE_ROOT"

STAMP_DIR="$THRONE_ROOT/vendor/.stamps"
FORCE=0

FORGEJO_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/forgejo"
FORGEJO_APP_INI="$FORGEJO_STATE_DIR/config/app.ini"
FORGEJO_INSTALLED_MARKER="$FORGEJO_STATE_DIR/enabled"
FORGEJO_ADMIN_PASSWORD_FILE="$FORGEJO_STATE_DIR/admin-password"
FORGEJO_API_TOKEN_FILE="$FORGEJO_STATE_DIR/api-token"
FORGEJO_API_TOKEN_NAME=throne-forge
FORGEJO_API_TOKEN_SCOPES=all
FORGEJO_CONTAINER=throne-forgejo
FORGEJO_SERVICE=forgejo.service
FORGEJO_LAUNCHD_LABEL=com.throne.forgejo
FORGEJO_MAC_LOG="$HOME/Library/Logs/throne/forgejo.log"
FORGEJO_HTTP_PORT=8420
FORGEJO_LOOPBACK_ADDRESS=127.0.0.1
FORGEJO_LOOPBACK_HTTP_PORT=8421
FORGEJO_HTTPS_PORT=8443
FORGEJO_CONTAINER_HTTP_PORT=3000
FORGEJO_CONTAINER_WORK_PATH=/var/lib/gitea
FORGEJO_ATTACHMENT_TYPES=.png,.jpg,.jpeg,.gif,.svg,.webp,.mp4,.webm,.mov
FORGEJO_ATTACHMENT_MAX_SIZE_MEGABYTES=500
MAC_TAILSCALE_CLI=/Applications/Tailscale.app/Contents/MacOS/Tailscale
TEA_BINARY="$HOME/.local/bin/tea"
TEA_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/throne/tea"
TEA_RELEASE_URL=https://gitea.com/gitea/tea/releases/download
TEA_LOGIN_NAME=forgejo

usage() {
    cat <<'EOF'
usage: ./install-forgejo.sh [--force] [--help]

  --force  Pull the pinned Forgejo image again even when it is present.

Installs the optional tailnet-only Forgejo forge, its API token and the pinned
tea CLI logged in to it. Re-running is safe: app.ini, the data directory, the
admin user, the API token and the tea login are never rewritten.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --force)   FORCE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "install-forgejo.sh: unknown argument \"$1\"" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

. "$THRONE_ROOT/scripts/require-agent.sh"
throne_require_agent install-forgejo.sh

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
did()  { printf '    \033[32m+\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31minstall-forgejo.sh: %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$STAMP_DIR"
stamp_is_current() {
    [ "$FORCE" -eq 0 ] && [ -f "$STAMP_DIR/$1" ] &&
        [ "$(cat "$STAMP_DIR/$1")" = "$2" ]
}
stamp_write() { printf '%s\n' "$2" > "$STAMP_DIR/$1"; }

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

container_engine() {
    local version_report server_report
    version_report=$("$RUNTIME" version 2>/dev/null || true)
    server_report=${version_report#*Server:}
    case "$server_report" in
        *'Podman Engine'*) printf 'Podman Engine' ;;
        *Engine*) printf 'Docker Engine' ;;
        *) printf 'an unknown container engine' ;;
    esac
}

tailscale_cli() {
    if command -v tailscale >/dev/null 2>&1; then
        printf 'tailscale'
    elif [ -x "$MAC_TAILSCALE_CLI" ]; then
        printf '%s' "$MAC_TAILSCALE_CLI"
    else
        return 1
    fi
}

tailnet_ipv4() {
    local address
    address=$("$TAILSCALE" ip -4 2>/dev/null | head -1 || true)
    case "$address" in
        ''|*[!0-9.]*) return 1 ;;
        *) printf '%s' "$address" ;;
    esac
}

magicdns_name() {
    "$TAILSCALE" status --self --json 2>/dev/null | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
        const name = JSON.parse(input).Self?.DNSName ?? "";
        process.stdout.write(name.replace(/\.$/, ""));
      });
    '
}

https_front_proxies_to() {
    "$TAILSCALE" serve status --json 2>/dev/null | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
        const [, site, target] = process.argv;
        const proxy = JSON.parse(input || "{}").Web?.[site]?.Handlers?.["/"]?.Proxy;
        process.exit(proxy === target ? 0 : 1);
      });
    ' "$1" "$2"
}

random_secret() {
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
}

write_app_ini() {
    local root_url=$1
    mkdir -p "$(dirname "$FORGEJO_APP_INI")" "$FORGEJO_STATE_DIR/data"
    (
        umask 077
        cat > "$FORGEJO_APP_INI" <<EOF
APP_NAME = Forgejo
RUN_MODE = prod
WORK_PATH = $FORGEJO_CONTAINER_WORK_PATH

[server]
DOMAIN = $DNS_NAME
ROOT_URL = $root_url
HTTP_PORT = $FORGEJO_CONTAINER_HTTP_PORT
DISABLE_SSH = true
START_SSH_SERVER = false

[database]
DB_TYPE = sqlite3

[security]
INSTALL_LOCK = true
SECRET_KEY = $(random_secret)
INTERNAL_TOKEN = $(random_secret)

[oauth2]
JWT_SECRET = $(random_secret)

[service]
DISABLE_REGISTRATION = true

[repository]
DEFAULT_REPO_UNITS = repo.code,repo.releases,repo.pulls

[attachment]
ENABLED = true
ALLOWED_TYPES = $FORGEJO_ATTACHMENT_TYPES
MAX_SIZE = $FORGEJO_ATTACHMENT_MAX_SIZE_MEGABYTES

[actions]
ENABLED = false

[packages]
ENABLED = false
EOF
    )
}

forgejo_service_inspection_hint() {
    if [ "$(uname -s)" = Darwin ]; then
        printf 'launchctl print gui/%s/%s and %s' "$(id -u)" "$FORGEJO_LAUNCHD_LABEL" "$FORGEJO_MAC_LOG"
    else
        printf 'systemctl --user status %s' "$FORGEJO_SERVICE"
    fi
}

forgejo_answers() {
    curl -fsS -o /dev/null "$1" >/dev/null 2>&1
}

admin_login_name() {
    printf '%s' "${1%%@*}" | tr '[:upper:]' '[:lower:]' |
        sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

api_token_is_accepted() {
    curl -fsS -o /dev/null \
        -H @<(printf 'Authorization: token %s\n' "$(cat "$FORGEJO_API_TOKEN_FILE")") \
        "${1}api/v1/user" >/dev/null 2>&1
}

tea_platform() {
    local system machine
    case "$(uname -s)" in
        Linux) system=linux ;;
        Darwin) system=darwin ;;
        *) return 1 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64) machine=amd64 ;;
        aarch64|arm64) machine=arm64 ;;
        *) return 1 ;;
    esac
    printf '%s-%s' "$system" "$machine"
}

tea_pin() {
    node -e '
      const [, pinsFile, platform] = process.argv;
      const tea = require(pinsFile).tools?.tea;
      const sha256 = tea?.artifacts?.[platform]?.sha256;
      if (!tea?.version || !sha256) process.exit(1);
      process.stdout.write([tea.version, sha256].join("\t"));
    ' "$THRONE_ROOT/vendor-pins.json" "$1"
}

installed_tea_version() {
    "$1" --version 2>/dev/null |
        LC_ALL=C sed -E "s/$(printf '\033')\[[0-9;]*m//g" |
        sed -n -E 's/^Version: ([0-9][0-9.]*).*/\1/p'
}

file_has_sha256() {
    [ -f "$1" ] && [ "$(sha256_of "$1")" = "$2" ]
}

tea_login_exists() {
    "$TEA_BINARY" logins list -o simple |
        awk -v name="$1" '$1 == name { found = 1 } END { exit !found }'
}

forgejo_user_exists() {
    "$RUNTIME" exec "$FORGEJO_CONTAINER" forgejo admin user list |
        awk -v login="$1" 'NR > 1 && $2 == login { found = 1 } END { exit !found }'
}

step "Preflight"

. "$THRONE_ROOT/bin/pinned-node-lib.sh"
use_pinned_node "$THRONE_ROOT" || die "the node pinned in mise.toml is not installed; run ./install.sh first."
ok "node $("$pinned_node" --version) (pinned in mise.toml)"

if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
    die "neither \`sha256sum\` nor \`shasum\` is on PATH; install coreutils or perl and re-run."
fi

[ -f dist/src/tools.js ] || die "no dist/src/tools.js; run ./install.sh (or npm run build) first."

RUNTIME=$(container_runtime) ||
    die "no container runtime found (looked for docker, podman); Forgejo runs as a container.
     Install Docker Desktop / docker-ce or podman, then re-run. Set
     THRONE_CONTAINER_RUNTIME=<name> to force a specific one."
"$RUNTIME" info >/dev/null 2>&1 ||
    die "$RUNTIME is installed but not reachable (\`$RUNTIME info\` failed).
     Start it (Docker Desktop, \`podman machine start\`, or the docker service), then re-run."
CONTAINER_ENGINE=$(container_engine)
ok "container engine: $CONTAINER_ENGINE (through $RUNTIME)"

TAILSCALE=$(tailscale_cli) ||
    die "tailscale is not installed (not on PATH, no $MAC_TAILSCALE_CLI); Forgejo is tailnet-only.
     Install it (https://tailscale.com/download), run \`tailscale up\`, and re-run."
TAILNET_IP=$(tailnet_ipv4) ||
    die "tailscale holds no tailnet IPv4 address; run \`tailscale up\` (check \`tailscale status\`) and re-run."
ok "tailscale: $TAILSCALE ($TAILNET_IP)"

DNS_NAME=$(magicdns_name) || DNS_NAME=""
[ -n "$DNS_NAME" ] ||
    die "tailscale reports no MagicDNS name for this host; enable MagicDNS for the tailnet and re-run."
ok "MagicDNS name: $DNS_NAME"

step "Forgejo image"

forgejo_image=$(node -e '
  const image = require(process.argv[1]).tools?.forgejo?.image;
  if (!image) process.exit(1);
  process.stdout.write(image);
' "$THRONE_ROOT/vendor-pins.json") || die "no tools.forgejo.image pin in vendor-pins.json."

if stamp_is_current forgejo-image "$forgejo_image" &&
    "$RUNTIME" image inspect "$forgejo_image" >/dev/null 2>&1; then
    ok "Forgejo image $forgejo_image present in $CONTAINER_ENGINE"
else
    "$RUNTIME" pull "$forgejo_image"
    stamp_write forgejo-image "$forgejo_image"
    did "pulled $forgejo_image into $CONTAINER_ENGINE"
fi

step "HTTPS front (tailscale serve)"

http_url="http://$DNS_NAME:$FORGEJO_HTTP_PORT/"
https_url="https://$DNS_NAME:$FORGEJO_HTTPS_PORT/"
tailnet_url="http://$TAILNET_IP:$FORGEJO_HTTP_PORT/"
https_front_target="http://$FORGEJO_LOOPBACK_ADDRESS:$FORGEJO_LOOPBACK_HTTP_PORT"
https_front_configured=0
if https_front_proxies_to "$DNS_NAME:$FORGEJO_HTTPS_PORT" "$https_front_target"; then
    https_front_configured=1
    ok "tailscale serve already proxies https port $FORGEJO_HTTPS_PORT to $https_front_target"
elif "$TAILSCALE" serve --bg --https="$FORGEJO_HTTPS_PORT" "$https_front_target" >/dev/null; then
    https_front_configured=1
    did "tailscale serve proxies https port $FORGEJO_HTTPS_PORT to $https_front_target"
else
    warn "tailscale serve could not front Forgejo with HTTPS; it stays on plain http ($http_url)"
fi

step "app.ini"

if [ -f "$FORGEJO_APP_INI" ]; then
    ok "kept existing $FORGEJO_APP_INI"
else
    if [ "$https_front_configured" -eq 1 ]; then
        write_app_ini "$https_url"
    else
        write_app_ini "$http_url"
    fi
    did "wrote $FORGEJO_APP_INI"
fi

step "Install marker"

if [ -f "$FORGEJO_INSTALLED_MARKER" ]; then
    ok "$FORGEJO_INSTALLED_MARKER present"
else
    : > "$FORGEJO_INSTALLED_MARKER"
    did "wrote $FORGEJO_INSTALLED_MARKER"
fi

step "install-services ($FORGEJO_SERVICE)"

"$pinned_node" ./dist/src/tools.js install-services

step "Forgejo service"

if [ "$(uname -s)" = Darwin ]; then
    ok "launchd runs $FORGEJO_LAUNCHD_LABEL (bootstrapped by install-services)"
elif systemctl --user is-active --quiet "$FORGEJO_SERVICE" 2>/dev/null; then
    ok "$FORGEJO_SERVICE already running"
else
    systemctl --user start "$FORGEJO_SERVICE"
    did "started $FORGEJO_SERVICE"
fi

ready_attempts="${THRONE_FORGEJO_READY_ATTEMPTS:-120}"
ready=0
for _attempt in $(seq 1 "$ready_attempts"); do
    if forgejo_answers "$tailnet_url"; then
        ready=1
        break
    fi
    sleep 1
done
[ "$ready" -eq 1 ] ||
    die "Forgejo did not answer $tailnet_url after ${ready_attempts}s; inspect: $(forgejo_service_inspection_hint)"
ok "Forgejo answers at $tailnet_url"

step "Admin user"

git_identity_status=0
identity=$(bin/throne-cli git-identity) || git_identity_status=$?
[ "$git_identity_status" -eq 0 ] ||
    die "no git identity (bin/throne-cli git-identity exited $git_identity_status); set identity.name and identity.email in config.user.ts and re-run."
IFS=$'\t' read -r admin_full_name admin_email _ <<< "$identity"
admin_login=$(admin_login_name "$admin_email")
[ -n "$admin_login" ] || die "cannot derive a Forgejo login name from the identity email \"$admin_email\"."

if forgejo_user_exists "$admin_login"; then
    ok "admin $admin_login already exists; its password was stored at $FORGEJO_ADMIN_PASSWORD_FILE when it was created"
else
    admin_password=$(random_secret)
    (
        umask 077
        printf '%s\n' "$admin_password" > "$FORGEJO_ADMIN_PASSWORD_FILE"
    )
    chmod 600 "$FORGEJO_ADMIN_PASSWORD_FILE"
    "$RUNTIME" exec "$FORGEJO_CONTAINER" forgejo admin user create --admin \
        --username "$admin_login" --fullname "$admin_full_name" --email "$admin_email" \
        --password "$admin_password" --must-change-password=false >/dev/null
    did "created admin $admin_login ($admin_email)"
    printf '    admin password (shown once, also in %s): %s\n' "$FORGEJO_ADMIN_PASSWORD_FILE" "$admin_password"
fi

step "API token"

if [ -f "$FORGEJO_API_TOKEN_FILE" ]; then
    ok "kept existing $FORGEJO_API_TOKEN_FILE"
else
    api_token=$("$RUNTIME" exec "$FORGEJO_CONTAINER" forgejo admin user generate-access-token \
        --username "$admin_login" --token-name "$FORGEJO_API_TOKEN_NAME" \
        --scopes "$FORGEJO_API_TOKEN_SCOPES" --raw) ||
        die "Forgejo refused to create the access token \"$FORGEJO_API_TOKEN_NAME\" for $admin_login.
     If a token by that name already exists, delete it under Settings > Applications
     (signed in as $admin_login) and re-run."
    (
        umask 077
        printf '%s\n' "$api_token" > "$FORGEJO_API_TOKEN_FILE"
    )
    chmod 600 "$FORGEJO_API_TOKEN_FILE"
    did "created access token $FORGEJO_API_TOKEN_NAME for $admin_login in $FORGEJO_API_TOKEN_FILE"
fi
api_token_is_accepted "$tailnet_url" ||
    die "Forgejo does not accept the token in $FORGEJO_API_TOKEN_FILE (GET ${tailnet_url}api/v1/user failed); it was left as it is.
     To replace it, delete the token \"$FORGEJO_API_TOKEN_NAME\" under Settings > Applications
     (signed in as $admin_login), then: rm $FORGEJO_API_TOKEN_FILE; $TEA_BINARY logins delete $TEA_LOGIN_NAME; re-run."
ok "Forgejo accepts the token in $FORGEJO_API_TOKEN_FILE"

step "tea CLI"

TEA_PLATFORM=$(tea_platform) ||
    die "tea is pinned for linux and darwin on amd64 and arm64 only; this host is $(uname -s) $(uname -m)."
tea_pin_fields=$(tea_pin "$TEA_PLATFORM") ||
    die "no tools.tea pin with a sha256 for $TEA_PLATFORM in vendor-pins.json."
IFS=$'\t' read -r tea_version tea_sha256 <<< "$tea_pin_fields"
tea_artifact="tea-$tea_version-$TEA_PLATFORM"
tea_cached="$TEA_CACHE_DIR/$tea_version/$tea_artifact"

if [ -x "$TEA_BINARY" ] && [ "$(installed_tea_version "$TEA_BINARY")" = "$tea_version" ]; then
    ok "tea $tea_version already installed at $TEA_BINARY"
else
    if file_has_sha256 "$tea_cached" "$tea_sha256"; then
        ok "reusing the verified download $tea_cached"
    else
        mkdir -p "$(dirname "$tea_cached")"
        curl -fsSL -o "$tea_cached.partial" "$TEA_RELEASE_URL/v$tea_version/$tea_artifact" ||
            die "could not download $TEA_RELEASE_URL/v$tea_version/$tea_artifact"
        if ! file_has_sha256 "$tea_cached.partial" "$tea_sha256"; then
            downloaded_sha256=$(sha256_of "$tea_cached.partial")
            rm -f "$tea_cached.partial"
            die "the downloaded $tea_artifact has sha256 $downloaded_sha256, but vendor-pins.json pins $tea_sha256; refusing to install it."
        fi
        mv "$tea_cached.partial" "$tea_cached"
        did "downloaded $tea_artifact (sha256 matches the pin)"
    fi
    mkdir -p "$(dirname "$TEA_BINARY")"
    cp "$tea_cached" "$TEA_BINARY.partial"
    chmod 755 "$TEA_BINARY.partial"
    mv "$TEA_BINARY.partial" "$TEA_BINARY"
    did "installed tea $tea_version at $TEA_BINARY"
fi

step "tea login"

forgejo_root_url=$(sed -n 's/^ROOT_URL = //p' "$FORGEJO_APP_INI")
if tea_login_exists "$TEA_LOGIN_NAME"; then
    ok "tea login $TEA_LOGIN_NAME already exists"
else
    GITEA_SERVER_TOKEN=$(cat "$FORGEJO_API_TOKEN_FILE") \
        "$TEA_BINARY" login add --name "$TEA_LOGIN_NAME" --url "$forgejo_root_url" >/dev/null
    did "added tea login $TEA_LOGIN_NAME for $forgejo_root_url"
fi

step "Done"
if [ "$https_front_configured" -eq 1 ]; then
    printf '    Forgejo:        %s (tailnet-only)\n' "$https_url"
fi
cat <<EOF
    Forgejo (http): $http_url and $tailnet_url (tailnet-only)
    Admin login:    $admin_login (lower-cased email local part, other characters turned to -)
    Admin password: $FORGEJO_ADMIN_PASSWORD_FILE
    API token:      $FORGEJO_API_TOKEN_FILE
    tea:            $TEA_BINARY (login $TEA_LOGIN_NAME)
    Data:           $FORGEJO_STATE_DIR (app.ini in config/, repositories and SQLite in data/)

    Re-run I_AM_AN_AGENT=1 ./install-forgejo.sh after any git pull; it is idempotent
    and never rewrites app.ini, the data, the admin user, the API token or the tea login.
EOF
