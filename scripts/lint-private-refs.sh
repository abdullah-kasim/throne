#!/usr/bin/env bash
# Backstop for the repo's public-release hygiene rule (see AGENTS.md): this
# script itself must never carry a private identifier, because it would then
# be an inventory of exactly what it's hiding, exempt from its own grep. So
# it carries NO pattern literals — it reads them from an external file that
# never enters the repo: ${THRONE_PRIVATE_REFS:-$HOME/.config/throne/private-refs.txt},
# one extended-regex pattern per line, blank lines and #-comments skipped.
# Precision is that file's responsibility (see its own header comment); this
# script enforces whatever patterns it's handed, faithfully.
#
# No file present -> skip green, exit 0, so a public clone (which has no such
# file) never fails npm test for this reason. File present -> every pattern is
# grep -rnE'd over the git-tracked tree (so .git internals, node_modules, and
# build scratch never trip it); any hit is reported and the script exits
# non-zero after checking every pattern, not just the first.
set -euo pipefail
cd "$(dirname "$0")/.."

pattern_file="${THRONE_PRIVATE_REFS:-$HOME/.config/throne/private-refs.txt}"

if [ ! -f "$pattern_file" ]; then
  echo "lint-private-refs: no private-reference list configured at $pattern_file; skipping"
  exit 0
fi

violations_found=0

while IFS= read -r pattern || [ -n "$pattern" ]; do
  case "$pattern" in
    ''|'#'*) continue ;;
  esac

  hits=$(git grep -InE "$pattern" -- . 2>/dev/null || true)

  if [ -n "$hits" ]; then
    violations_found=1
    echo "lint-private-refs: banned pattern '$pattern' found (this repo is bound for public release — see AGENTS.md):" >&2
    echo "$hits" >&2
    echo "" >&2
  fi
done < "$pattern_file"

if [ "$violations_found" -ne 0 ]; then
  exit 1
fi

echo "lint-private-refs: no private references found against $pattern_file."
