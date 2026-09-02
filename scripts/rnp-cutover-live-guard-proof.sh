#!/usr/bin/env bash
#
# rnp-cutover-live-guard-proof.sh — proves rnp-herdr-cutover.sh's live-agent
# guard against both mandatory classes (Regent order, 2026-08-12):
#   - a court with a live agent is REFUSED
#   - an empty court PROCEEDS
# plus the two supporting properties the order also demanded:
#   - an unreadable probe FAILS CLOSED (refuses, not proceeds)
#   - --force proceeds anyway and loud-warns naming every agent first
#
# Stubs `herdr` and `systemctl` in an isolated PATH so this never touches a
# real herdr session or a real systemd unit. The mutating tail of
# rnp-herdr-cutover.sh (systemctl stop/disable/enable) is exercised too,
# against the stub, so a "proceeds" case is proven to reach the mutation,
# not just to fall through the guard.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
CUTOVER_SCRIPT="$SCRIPT_DIR/rnp-herdr-cutover.sh"

pass=0
fail=0
LAST_OUTPUT=""

# run_case <label> <expected_exit> <herdr_stub_body> [extra cutover args...]
run_case() {
    local label="$1" expected_exit="$2" herdr_stub_body="$3"; shift 3
    local stub_dir log_file actual_exit
    stub_dir=$(mktemp -d)
    log_file=$(mktemp)

    cat > "$stub_dir/herdr" <<STUB
#!/usr/bin/env bash
$herdr_stub_body
STUB
    chmod +x "$stub_dir/herdr"

    cat > "$stub_dir/systemctl" <<STUB
#!/usr/bin/env bash
echo "STUBBED-SYSTEMCTL: \$*" >> "$log_file"
exit 0
STUB
    chmod +x "$stub_dir/systemctl"

    LAST_OUTPUT=$(PATH="$stub_dir:$PATH" bash "$CUTOVER_SCRIPT" "$@" 2>&1)
    actual_exit=$?
    LAST_OUTPUT="$LAST_OUTPUT
$(cat "$log_file")"

    if [ "$actual_exit" -eq "$expected_exit" ]; then
        echo "PASS: $label (exit=$actual_exit)"
        pass=$((pass+1))
    else
        echo "FAIL: $label — expected exit $expected_exit, got $actual_exit" >&2
        echo "--- output ---" >&2
        echo "$LAST_OUTPUT" >&2
        fail=$((fail+1))
    fi
    rm -rf "$stub_dir" "$log_file"
}

check() {
    local desc="$1" pattern="$2" mode="${3:-must-contain}"
    if [ "$mode" = "must-contain" ]; then
        if echo "$LAST_OUTPUT" | grep -q -- "$pattern"; then
            echo "  ok: $desc"
        else
            echo "  FAIL: $desc — pattern not found: $pattern" >&2
            fail=$((fail+1))
        fi
    else
        if echo "$LAST_OUTPUT" | grep -q -- "$pattern"; then
            echo "  FAIL: $desc — forbidden pattern found: $pattern" >&2
            fail=$((fail+1))
        else
            echo "  ok: $desc"
        fi
    fi
}

echo "=== Case 1: live court (2 agent panes, one with a nested agent_session) -> REFUSED ==="
run_case "live court refuses" 1 'cat <<JSON
{"id":"cli:pane:list","result":{"panes":[
  {"agent":"claude","pane_id":"w1:pA"},
  {"agent":"claude","agent_session":{"agent":"claude","kind":"id","value":"nested-should-not-fool-us"},"pane_id":"w1:pB"},
  {"pane_id":"w1:pC"}
]}}
JSON'
check "reports exactly 2 agents (nested agent_session.agent must not be double-counted)" "2 live agent(s) detected"
check "names pane w1:pA" "w1:pA"
check "names pane w1:pB" "w1:pB"
check "never touches systemctl" "STUBBED-SYSTEMCTL" must-not-contain

echo
echo "=== Case 2: empty court -> PROCEEDS ==="
run_case "empty court proceeds" 0 'cat <<JSON
{"id":"cli:pane:list","result":{"panes":[
  {"pane_id":"w1:pA"},
  {"pane_id":"w1:pB"}
]}}
JSON'
check "confirms zero live agents" "confirms zero live agents"
check "reaches systemctl stop herdr-server" "stop herdr-server.service"
check "reaches systemctl enable --now throne-herdr" "enable --now throne-herdr.service"

echo
echo "=== Case 3: probe unreadable -> FAILS CLOSED ==="
run_case "unreadable probe fails closed" 1 'exit 1'
check "fails closed with explicit message" "REFUSING (fail closed)"
check "never touches systemctl" "STUBBED-SYSTEMCTL" must-not-contain

echo
echo "=== Case 4: live court + --force -> proceeds, loud-warns naming the kill ==="
run_case "live court with --force proceeds and names the kill" 0 \
    'cat <<JSON
{"id":"cli:pane:list","result":{"panes":[{"agent":"claude","pane_id":"w1:pA"}]}}
JSON' --force
check "loud-warns naming the specific agent about to die" "KILLING: pane:w1:pA"
check "reaches systemctl despite the live agent (force honored)" "stop herdr-server.service"

echo
echo "TOTAL: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
