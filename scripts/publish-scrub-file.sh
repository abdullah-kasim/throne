NEVER_PUBLISHED_PATHS=(publish.sh publish-scrub.sed import-from-public.sh current_public_commit.txt bots .claude/skills/publish)

publish_scrub_file() {
  printf '%s\n' "${PUBLISH_SCRUB_FILE:-$1/publish-scrub.sed}"
}

print_verify_patterns() {
  sed -nE 's/^# ?verify:[[:space:]]*//p' "$1"
}
