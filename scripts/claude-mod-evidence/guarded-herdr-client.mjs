import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeGuardedHerdrClient({ folder, realClient, recipients }) {
  const clientPath = path.join(folder, "guarded-herdr");
  const refusalLog = path.join(folder, "guarded-herdr-refusals.log");
  const recipientPattern = recipients.map((recipient) => `"${recipient}"`).join(" ");
  const script = `#!/usr/bin/env bash
arguments=("$@")
if [ "\${arguments[0]}" = "--session" ]; then arguments=("\${arguments[@]:2}"); fi
command_words="\${arguments[0]} \${arguments[1]}"
target="\${arguments[2]}"
case "$command_words" in
  "pane send-text"|"pane send-keys"|"pane read"|"agent read")
    for recipient in ${recipientPattern}; do
      if [ "$target" = "$recipient" ]; then
        printf '%s\\n' "$*" >> "${refusalLog}"
        echo "guarded herdr client: refusing $command_words for recipient $target" >&2
        exit 97
      fi
    done
    ;;
esac
exec "${realClient}" "$@"
`;
  await writeFile(clientPath, script, "utf8");
  await chmod(clientPath, 0o755);
  return { clientPath, refusalLog };
}
