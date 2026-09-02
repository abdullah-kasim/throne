# require-agent.sh — refuse to run unless I_AM_AN_AGENT=1 is set.
#
# Sourced by ./install.sh and ./uninstall.sh. Both scripts touch the host's
# service manager, download pinned binaries, and pull container images; when
# any of that fails the useful response is to READ the error and fix the
# machine, then re-run — which is exactly what an agent does and a human
# pasting commands does not. So the throne's operating contract is: a human
# starts an agent in the checkout and asks it to run the installer; the agent
# runs it with the flag, repairs what breaks, and its LAST message tells the
# human to quit the agent and run `throne`.
#
# The check is deliberately just an environment flag. The refusal below is
# written for both readers: an agent that sees it re-runs with the flag; a
# human that sees it goes and gets an agent.

throne_require_agent() {
    local script_name=$1
    if [ "${I_AM_AN_AGENT:-}" = "1" ]; then
        return 0
    fi
    cat >&2 <<EOF

$script_name: refusing to run without I_AM_AN_AGENT=1.

  The throne is installed and removed BY AN AGENT, not by hand: it reads
  whatever breaks on this machine, fixes it, and re-runs until the script
  is clean. A human pasting commands stops at the first error.

  If you are an AI agent, re-run as:

      I_AM_AN_AGENT=1 ./$script_name

  If you are a human, start an agent (claude, codex, opencode) in this
  directory and ask it to run ./$script_name for you.

EOF
    exit 3
}
