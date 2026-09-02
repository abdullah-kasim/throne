import type { SwitchRequest } from "../session/session.contracts.ts";
import { renderFrameworkEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

export const SWITCH_AGENT_MODEL_USAGE =
  "Usage: ./bin/throne-cli switch-agent-model <agent> --model <target> [--effort <1-6>] [--bypass-model] [--bypass-effort] [--bypass-zero-quota] --confirm\n";
export const SWITCH_AGENT_MODEL_HELP = `${SWITCH_AGENT_MODEL_USAGE}
Safely switch one idle registered agent within its current launcher family by
closing the live tab and exact-resuming the same native session.

Options:
  --model <target>  Target model (required)
  --effort <1-6>    Target effort; defaults to the stored effort
  --bypass-model    Override only the role model steer
  --bypass-effort   Override only the ordinary effort steer
  --bypass-zero-quota
                    Override only trustworthy exact-zero target quota
  --confirm         Execute the reviewed switch; without it, preview only
  --help            Show this help

Safety:
  The command refuses before close unless it can prove the registered pane,
  cwd, idle state, empty composer, session identity, and supported recipe.

Stable outcome markers:
  outcome: switched; spawn.json changed: yes
  outcome: refused-before-close; spawn.json changed: no
  outcome: target-failed/rollback-failed; spawn.json changed: unknown
`;
export const ABSENT_FILE = "absent";

export interface ParsedSwitchAgentModelArgs {
  agentName: string;
  request: SwitchRequest;
  bypass: RegisteredSwitchBypass;
  confirm: boolean;
}

export interface RegisteredSwitchBypass {
  model: boolean;
  effort: boolean;
  zeroQuota: boolean;
}

const BYPASS_FLAGS = new Map([
  ["--bypass-model", "model"],
  ["--bypass-effort", "effort"],
  ["--bypass-zero-quota", "zeroQuota"],
] as const);

function parseValueFlag(
  args: readonly string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

export function parseSwitchAgentModelArgs(
  args: readonly string[],
): ParsedSwitchAgentModelArgs {
  let agentName: string | undefined;
  let model: string | undefined;
  let effort: number | undefined;
  let confirm = false;
  const bypass: RegisteredSwitchBypass = {
    model: false,
    effort: false,
    zeroQuota: false,
  };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--confirm") {
      if (seen.has(arg)) throw new Error(`duplicate argument "${arg}"`);
      seen.add(arg);
      confirm = true;
      continue;
    }
    const bypassKey = BYPASS_FLAGS.get(arg as never);
    if (bypassKey !== undefined) {
      if (seen.has(arg)) throw new Error(`duplicate argument "${arg}"`);
      seen.add(arg);
      bypass[bypassKey] = true;
      continue;
    }
    if (arg === "--model" || arg === "--effort") {
      if (seen.has(arg)) throw new Error(`duplicate argument "${arg}"`);
      seen.add(arg);
      const parsed = parseValueFlag(args, index, arg);
      index = parsed.nextIndex;
      if (arg === "--model") {
        if (parsed.value.trim() === "")
          throw new Error("--model requires a non-empty value");
        model = parsed.value;
      } else {
        const numeric = Number(parsed.value);
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > 6) {
          throw new Error(
            `--effort must be an integer 1-6, got "${parsed.value}"`,
          );
        }
        effort = numeric;
      }
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown argument "${arg}"`);
    if (agentName !== undefined)
      throw new Error(`unexpected argument "${arg}"`);
    agentName = arg;
  }

  if (agentName === undefined || agentName.trim() === "") {
    throw new Error("missing <agent>");
  }
  if (model === undefined) throw new Error("missing required --model <target>");
  return {
    agentName,
    request: { model, ...(effort === undefined ? {} : { effort }) },
    bypass,
    confirm,
  };
}

export function writeSwitchAgentModelFrameworkFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `switch-agent-model: ${message}\n${SWITCH_AGENT_MODEL_USAGE}` +
      `${renderFrameworkEntranceRefusal("switch-agent-model", message, { available: false })}\n`,
  );
  process.stdout.write(
    "outcome: refused-before-close; spawn.json changed: no\n",
  );
  process.exitCode = 1;
}
