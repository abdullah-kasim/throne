import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FAKE_LAUNCHCTL = `#!/bin/sh
echo "launchctl $*" >> "$STATE/calls"
lingering=$(cat "$STATE/lingering" 2>/dev/null || echo 0)
refusals=$(cat "$STATE/refusals" 2>/dev/null || echo 0)
loaded=$(cat "$STATE/loaded" 2>/dev/null)
case "$1" in
  bootout) echo "$LINGERING_PRINTS" > "$STATE/lingering"; : > "$STATE/loaded" ;;
  print)
    if [ "$lingering" -gt 0 ]; then echo $((lingering - 1)) > "$STATE/lingering"; echo "arguments = { exec $OLD_BINARY }"; exit 0; fi
    if [ -n "$loaded" ]; then echo "arguments = { exec $loaded --session throne server }"; exit 0; fi
    echo "Could not find service" >&2; exit 113 ;;
  bootstrap)
    if [ "$lingering" -gt 0 ] || [ -n "$loaded" ]; then echo "bootstrap while still loaded" >> "$STATE/calls"; echo "Try re-running as root" >&2; exit 5; fi
    if [ "$refusals" -gt 0 ]; then echo $((refusals - 1)) > "$STATE/refusals"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    echo "$BINARY_LAUNCHD_LOADS" > "$STATE/loaded" ;;
esac
exit 0
`;

const FAKE_SYSTEMCTL = `#!/bin/sh
echo "systemctl $*" >> "$STATE/calls"
case "$2" in
  is-active) exit "$BOT_UNIT_ACTIVE_EXIT" ;;
  try-restart) exit "\${TRY_RESTART_EXIT:-0}" ;;
esac
exit 0
`;

const FAKE_BUSCTL = `#!/bin/sh
echo "busctl $*" >> "$STATE/calls"
if [ "$MOVE_OUTCOME" = refused ]; then echo 'Call failed: Access denied' >&2; exit 1; fi
if [ "$MOVE_OUTCOME" = moved ]; then
  for word in "$@"; do
    case "$word" in *.scope) scope=$word ;; esac
  done
  sed -E "s|/[^/]*[.]service\\$|/$scope|" "$STATE/signing-agents" > "$STATE/signing-agents.next"
  mv "$STATE/signing-agents.next" "$STATE/signing-agents"
fi
echo 'o "/org/freedesktop/systemd1/job/1"'
`;

export const SERVICE_MANAGER_COMMANDS = ['systemctl', 'launchctl', 'busctl'] as const;
const SERVICE_MANAGER_FAKES = { systemctl: FAKE_SYSTEMCTL, launchctl: FAKE_LAUNCHCTL, busctl: FAKE_BUSCTL };

export async function writeExecutables(executables: readonly (readonly [string, string])[]): Promise<void> {
  for (const [file, body] of executables) {
    await writeFile(file, body);
    await chmod(file, 0o755);
  }
}

export async function runForExitCode(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, options);
    return { exitCode: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { exitCode: failed.code, output: failed.stdout + failed.stderr };
  }
}

export function runBash(script: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; output: string }> {
  return runForExitCode('bash', ['-c', script], { env });
}

export async function writeServiceManagerFakes(fakes: string): Promise<void> {
  await writeExecutables(SERVICE_MANAGER_COMMANDS.map((command) => [path.join(fakes, command), SERVICE_MANAGER_FAKES[command]]));
}

export function fakeHostEnvironment(scratch: string): NodeJS.ProcessEnv {
  const noUserManager = path.join(scratch, 'no-user-manager');
  return {
    ...process.env,
    LC_ALL: 'C',
    PATH: `${path.join(scratch, 'bin')}:${process.env.PATH}`,
    STATE: scratch,
    XDG_RUNTIME_DIR: noUserManager,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(noUserManager, 'bus')}`,
  };
}
