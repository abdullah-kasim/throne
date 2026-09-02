#!/usr/bin/env bash
# Standalone extraction/proof harness for uninstall.sh's HERDR_UNIT_NAMES
# dual-name live-court guard. Never invokes uninstall.sh itself — stubs
# systemctl in an isolated PATH and re-implements only the detection snippet
# verbatim from uninstall.sh to prove it resolves the active unit under
# EITHER name.
set -euo pipefail

run_case() {
    local label="$1" active_unit="$2"
    echo "=== case: $label (active=$active_unit) ==="

    local stub_dir
    stub_dir=$(mktemp -d)
    cat > "$stub_dir/systemctl" <<STUB
#!/usr/bin/env bash
if [ "\$1" = "--user" ] && [ "\$2" = "is-active" ]; then
    unit="\$4"
    [ "\$unit" = "$active_unit" ] && exit 0
    exit 3
fi
exit 0
STUB
    chmod +x "$stub_dir/systemctl"

    (
        PATH="$stub_dir:$PATH"
        HOME_STUB=$(mktemp -d)
        mkdir -p "$HOME_STUB/.config/systemd/user"
        # --- verbatim guard snippet from uninstall.sh ---
        have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d "$HOME_STUB/.config/systemd/user" ]; }
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
        fi
        echo "herdr_server_active=$herdr_server_active herdr_active_unit=$herdr_active_unit"
        if [ "$herdr_server_active" -ne 1 ]; then
            echo "FAIL: guard did not detect $active_unit as active" >&2
            exit 1
        fi
        if [ "$herdr_active_unit" != "$active_unit" ]; then
            echo "FAIL: resolved wrong unit name" >&2
            exit 1
        fi
        echo "PASS"
    )
    rm -rf "$stub_dir"
}

run_case "legacy name active" "herdr-server.service"
run_case "renamed unit active" "throne-herdr.service"
echo "all cases passed"
