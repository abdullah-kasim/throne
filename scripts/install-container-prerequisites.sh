#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
CHECK_ONLY=0
LINUX_PACKAGES="podman podman-docker"

usage() {
    cat <<'EOF'
usage: scripts/install-container-prerequisites.sh [--check] [--help]

  Installs what is missing of Podman, its Docker compatibility and the
  Docker CLI, on macOS (Homebrew) and Linux (apt, dnf, pacman, zypper).
  A container runtime that already answers `info` is left exactly as is.

  --check        Report what is missing and change nothing.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --check)   CHECK_ONLY=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "install-container-prerequisites.sh: unknown argument \"$1\"" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

. "$SCRIPT_DIR/require-agent.sh"
throne_require_agent scripts/install-container-prerequisites.sh

needs_you() {
    printf 'needs you: %s\n' "$1"
    exit 2
}

first_runtime_on_path() {
    local candidate
    for candidate in ${THRONE_CONTAINER_RUNTIME:-} docker podman; do
        if command -v "$candidate" >/dev/null 2>&1; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

report_ready_when_working() {
    local runtime
    runtime=$(first_runtime_on_path) || return 1
    "$runtime" info >/dev/null 2>&1 || return 1
    printf 'container runtime: ready (%s)\n' "$runtime"
    exit 0
}

report_missing() {
    local anything_named=0
    if ! command -v podman >/dev/null 2>&1; then
        echo "missing: podman"
        anything_named=1
    fi
    if ! command -v docker >/dev/null 2>&1; then
        echo "missing: docker cli"
        anything_named=1
    fi
    if [ "$anything_named" = 0 ]; then
        echo "missing: a reachable container engine (docker info fails)"
    fi
    echo "container runtime: missing"
    exit 1
}

as_root() {
    if [ "$(id -u)" = 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        sudo "$@"
    else
        needs_you "run \`sudo $*\` yourself, then re-run this script"
    fi
}

install_on_macos() {
    command -v brew >/dev/null 2>&1 ||
        needs_you "Homebrew is not installed; install it from https://brew.sh, then re-run this script"
    command -v podman >/dev/null 2>&1 || brew install podman
    command -v docker >/dev/null 2>&1 || brew install docker
    if [ -z "$(podman machine list --format '{{.Name}}' 2>/dev/null)" ]; then
        podman machine init
    fi
    podman info >/dev/null 2>&1 || podman machine start
    if ! docker info >/dev/null 2>&1; then
        local socket
        socket=$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')
        docker context inspect podman >/dev/null 2>&1 ||
            docker context create podman --docker "host=unix://$socket"
        docker context use podman
    fi
}

install_on_linux() {
    if command -v podman >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
        :
    elif command -v rpm-ostree >/dev/null 2>&1; then
        needs_you "this image-based host lacks podman or docker ($LINUX_PACKAGES); add them to the image, this script never layers packages"
    elif command -v apt-get >/dev/null 2>&1; then
        as_root apt-get update
        as_root apt-get install -y podman podman-docker
    elif command -v dnf >/dev/null 2>&1; then
        as_root dnf install -y podman podman-docker
    elif command -v pacman >/dev/null 2>&1; then
        as_root pacman -S --needed --noconfirm podman podman-docker
    elif command -v zypper >/dev/null 2>&1; then
        as_root zypper --non-interactive install podman podman-docker
    else
        needs_you "no apt-get, dnf, pacman or zypper found; install $LINUX_PACKAGES with this host's package manager"
    fi
    systemctl --user is-active --quiet podman.socket ||
        systemctl --user enable --now podman.socket
}

report_ready_when_working || true
[ "$CHECK_ONLY" = 1 ] && report_missing

case "$(uname -s)" in
    Darwin) install_on_macos ;;
    Linux)  install_on_linux ;;
    *) needs_you "$(uname -s) is not supported; only macOS and Linux are" ;;
esac

if docker info >/dev/null 2>&1; then
    echo "container runtime: ready (docker)"
    exit 0
fi
echo "docker info still fails after installing; read its error and fix the engine, then re-run"
echo "container runtime: missing"
exit 1
