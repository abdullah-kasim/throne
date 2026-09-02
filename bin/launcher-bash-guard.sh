# launcher-bash-guard.sh — guarantee a bash new enough for the launcher library.
#
# `agent-launcher-lib.sh` writes through `local -n` namerefs, which need bash
# 4.3. Stock macOS still ships bash 3.2, so both entry scripts source THIS file
# and call `throne_launcher_require_modern_bash` BEFORE sourcing the library.
# That ordering only helps if this file itself runs on the old bash it is
# meant to catch: keep it free of namerefs, `${var^^}`, associative arrays,
# `readlink -f`, and every other post-3.2 construct.
# shellcheck shell=bash

THRONE_LAUNCHER_MIN_BASH_MAJOR=4
THRONE_LAUNCHER_MIN_BASH_MINOR=3

# Exit status used when no usable bash exists. 78 is sysexits' EX_CONFIG: the
# machine is misconfigured for these launchers, nothing the arguments can fix.
THRONE_LAUNCHER_NO_MODERN_BASH_EXIT=78

# The version test, as a snippet a candidate bash runs against itself. Asking
# the candidate beats parsing `--version` prose, whose shape varies by build.
# shellcheck disable=SC2016
# ^ the single quotes are the point: BASH_VERSINFO must expand in the candidate
# being probed, never in the shell writing the probe.
throne_launcher_bash_version_probe() {
    printf 'if [ "${BASH_VERSINFO[0]:-0}" -gt %s ]; then exit 0; fi; if [ "${BASH_VERSINFO[0]:-0}" -eq %s ] && [ "${BASH_VERSINFO[1]:-0}" -ge %s ]; then exit 0; fi; exit 1' \
        "$THRONE_LAUNCHER_MIN_BASH_MAJOR" \
        "$THRONE_LAUNCHER_MIN_BASH_MAJOR" \
        "$THRONE_LAUNCHER_MIN_BASH_MINOR"
}

# Where a newer bash is looked for, in order, one path per line.
# $THRONE_LAUNCHER_BASH is the documented explicit override.
throne_launcher_bash_candidates() {
    if [ -n "${THRONE_LAUNCHER_BASH:-}" ]; then
        printf '%s\n' "$THRONE_LAUNCHER_BASH"
    fi
    printf '%s\n' /opt/homebrew/bin/bash /usr/local/bin/bash
    type -aP bash 2>/dev/null
}

# True when the bash executing this script meets the minimum.
# $THRONE_LAUNCHER_FORCE_BASH_VERSION overrides the reading when set, so a
# modern bash can be walked down the old-bash path deterministically.
throne_launcher_running_bash_is_supported() {
    local forced major minor
    forced="${THRONE_LAUNCHER_FORCE_BASH_VERSION:-}"

    if [ -n "$forced" ]; then
        case "$forced" in
            *.*)
                major="${forced%%.*}"
                minor="${forced#*.}"
                minor="${minor%%.*}"
                ;;
            *)
                major="$forced"
                minor=0
                ;;
        esac
    else
        major="${BASH_VERSINFO[0]}"
        minor="${BASH_VERSINFO[1]}"
    fi

    case "$major" in ''|*[!0-9]*) major=0 ;; esac
    case "$minor" in ''|*[!0-9]*) minor=0 ;; esac

    [ "$major" -gt "$THRONE_LAUNCHER_MIN_BASH_MAJOR" ] && return 0
    [ "$major" -eq "$THRONE_LAUNCHER_MIN_BASH_MAJOR" ] && [ "$minor" -ge "$THRONE_LAUNCHER_MIN_BASH_MINOR" ] && return 0
    return 1
}

throne_launcher_bash_candidate_is_supported() {
    local candidate="$1"
    [ -n "$candidate" ] || return 1
    [ -x "$candidate" ] || return 1
    "$candidate" -c "$(throne_launcher_bash_version_probe)" >/dev/null 2>&1
}

throne_launcher_fail_without_modern_bash() {
    local reason="$1"
    local minimum="${THRONE_LAUNCHER_MIN_BASH_MAJOR}.${THRONE_LAUNCHER_MIN_BASH_MINOR}"
    {
        echo "throne launcher: bash $minimum or newer is required ($reason)."
        echo "  running bash: ${BASH_VERSION:-unknown}"
        echo "  searched: \$THRONE_LAUNCHER_BASH, /opt/homebrew/bin/bash, /usr/local/bin/bash, then every 'bash' on PATH"
        echo "  remedy: install a newer bash (macOS: 'brew install bash'), or point \$THRONE_LAUNCHER_BASH at one"
    } >&2
    exit "$THRONE_LAUNCHER_NO_MODERN_BASH_EXIT"
}

# Return only when the caller is running on a supported bash: re-exec the whole
# script into the first supported candidate otherwise, and fail loudly when
# there is none. $1 is the script to re-exec, the rest its original arguments.
throne_launcher_require_modern_bash() {
    local script_path="$1"
    shift

    throne_launcher_running_bash_is_supported && return 0

    # An exported sentinel makes a second pass fail instead of re-execing
    # forever when a candidate reports a version it does not deliver.
    if [ -n "${THRONE_LAUNCHER_BASH_REEXEC:-}" ]; then
        throne_launcher_fail_without_modern_bash "already re-executed once, and this bash is still too old"
    fi

    local candidate
    while IFS= read -r candidate; do
        if throne_launcher_bash_candidate_is_supported "$candidate"; then
            THRONE_LAUNCHER_BASH_REEXEC=1
            export THRONE_LAUNCHER_BASH_REEXEC
            exec "$candidate" "$script_path" "$@"
        fi
    done < <(throne_launcher_bash_candidates)

    throne_launcher_fail_without_modern_bash "no bash on this machine met it"
}
