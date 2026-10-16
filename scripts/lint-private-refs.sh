#!/usr/bin/env bash
# Backstop for the repo's public-release hygiene rule (see AGENTS.md): every
# `# verify:` pattern of publish-scrub.sed — the one list of private terms,
# tracked in this private repo and never published — is matched with
# grep -nIE, as publish.sh's verify step matches it, over every git-tracked
# file publish.sh could copy (NEVER_PUBLISHED_PATHS and LICENSE are skipped).
# The scrub file is found as publish.sh finds it: ${PUBLISH_SCRUB_FILE:-<checkout>/publish-scrub.sed}.
#
# No scrub file present -> skip green, exit 0, so a public clone (which has no
# such file) never fails npm test for this reason. File present -> any hit is
# reported and the script exits non-zero after checking every pattern, not
# just the first.
set -euo pipefail
checkout="$(cd "$(dirname "$0")/.." && pwd)"
source "$checkout/scripts/publish-scrub-file.sh"

scrub_file="$(publish_scrub_file "$checkout")"

if [ ! -f "$scrub_file" ]; then
  echo "lint-private-refs: no private-reference list configured at $scrub_file; skipping"
  exit 0
fi

list_publishable_files() {
  git ls-files -z -- . "${NEVER_PUBLISHED_PATHS[@]/#/:!}" ':(exclude,glob)**/LICENSE'
}

violations_found=0

while IFS= read -r pattern; do
  [ -n "$pattern" ] || continue

  hits=$(cd "$checkout" && list_publishable_files | xargs -0 grep -HnIE -e "$pattern" -- 2>/dev/null || true)

  if [ -n "$hits" ]; then
    violations_found=1
    echo "lint-private-refs: banned pattern '$pattern' found (this repo is bound for public release — see AGENTS.md):" >&2
    echo "$hits" >&2
    echo "" >&2
  fi
done < <(print_verify_patterns "$scrub_file")

if [ "$violations_found" -ne 0 ]; then
  exit 1
fi

echo "lint-private-refs: no private references found against $scrub_file."
