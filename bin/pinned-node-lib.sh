pinned_node_version() {
    local throne_root="$1"
    local version
    version=$(awk -F'"' '/^\[/ { in_tools = ($0 ~ /^\[tools\]/); next } in_tools && /^[[:space:]]*node[[:space:]]*=/ { print $2; exit }' "$throne_root/mise.toml" 2>/dev/null)
    if [ -z "$version" ]; then
        echo "throne: $throne_root/mise.toml does not pin node under [tools]; restore its node = \"<version>\" line" >&2
        return 1
    fi
    printf '%s\n' "$version"
}

pinned_node_bin() {
    local throne_root="$1"
    local version node_bin
    version=$(pinned_node_version "$throne_root") || return 1
    node_bin="$HOME/.local/share/mise/installs/node/$version/bin/node"
    if [ ! -x "$node_bin" ]; then
        echo "throne: node $version, pinned in $throne_root/mise.toml, is not installed at $node_bin; run \`mise install\` in $throne_root" >&2
        return 1
    fi
    printf '%s\n' "$node_bin"
}

use_pinned_node() {
    pinned_node=$(pinned_node_bin "$1") || return 1
    PATH="${pinned_node%/node}:$PATH"
    export PATH
}

pinned_node_reports_pinned_version() {
    local throne_root="$1"
    local version node_bin reported_version
    version=$(pinned_node_version "$throne_root") || return 1
    node_bin=$(pinned_node_bin "$throne_root") || return 1
    reported_version=$("$node_bin" --version 2>/dev/null)
    if [ "$reported_version" != "v$version" ]; then
        echo "throne: $node_bin reports ${reported_version:-no version}, not v$version pinned in $throne_root/mise.toml; run \`mise install\` in $throne_root" >&2
        return 1
    fi
}
