#!/usr/bin/env bash
set -euo pipefail

THRONE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
VENDOR_BIN="$THRONE_ROOT/vendor/bin"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/throne/search-tools"

if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | awk '{ print $1 }'; }
else
    sha256_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }
fi

file_has_sha256() {
    [ -f "$1" ] && [ "$(sha256_of "$1")" = "$2" ]
}

host_platform() {
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

search_tool_pin() {
    "$THRONE_ROOT/bin/throne-runtime" -e '
      const [, pinsFile, name, platform] = process.argv;
      const tool = require(pinsFile).tools?.[name];
      const artifact = tool?.artifacts?.[platform];
      if (!tool?.version || !tool.binary || !tool.releaseUrl || !artifact?.archive || !artifact.sha256) process.exit(1);
      process.stdout.write([tool.version, tool.binary, tool.releaseUrl, artifact.archive, artifact.sha256].join("\t"));
    ' "$THRONE_ROOT/vendor-pins.json" "$1" "$2"
}

install_search_tool() {
    local name=$1 platform=$2 pin_fields version binary release_url archive sha256
    pin_fields=$(search_tool_pin "$name" "$platform") || {
        echo "no tools.$name pin for $platform in vendor-pins.json" >&2
        return 1
    }
    IFS=$'\t' read -r version binary release_url archive sha256 <<< "$pin_fields"
    local installed="$VENDOR_BIN/$binary"
    if [ -x "$installed" ] && [ "$("$installed" --version 2>/dev/null | head -n 1 | awk '{ print $2 }')" = "$version" ]; then
        echo "    ok: $binary $version already at $installed"
        return 0
    fi
    local cached="$CACHE_DIR/$version/$archive"
    if ! file_has_sha256 "$cached" "$sha256"; then
        mkdir -p "$(dirname "$cached")"
        curl -fsSL -o "$cached.partial" "$release_url/$archive" || {
            rm -f "$cached.partial"
            echo "could not download $release_url/$archive" >&2
            return 1
        }
        if ! file_has_sha256 "$cached.partial" "$sha256"; then
            echo "the downloaded $archive has sha256 $(sha256_of "$cached.partial"), but vendor-pins.json pins $sha256; refusing to install it" >&2
            rm -f "$cached.partial"
            return 1
        fi
        mv "$cached.partial" "$cached"
    fi
    local unpacked
    unpacked=$(mktemp -d)
    tar -xzf "$cached" -C "$unpacked" "${archive%.tar.gz}/$binary"
    mkdir -p "$VENDOR_BIN"
    mv "$unpacked/${archive%.tar.gz}/$binary" "$installed.partial"
    rm -rf "$unpacked"
    chmod 755 "$installed.partial"
    mv "$installed.partial" "$installed"
    echo "    + installed $binary $version at $installed"
}

platform=$(host_platform) || {
    echo "ripgrep and fd are pinned for linux and darwin on amd64 and arm64 only; this host is $(uname -s) $(uname -m)" >&2
    exit 1
}
failed=0
install_search_tool ripgrep "$platform" || failed=1
install_search_tool fd "$platform" || failed=1
exit "$failed"
