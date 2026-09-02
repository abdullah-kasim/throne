import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import type { ParsedFlags } from "./create.types.ts";

const BOOLEAN_FLAGS = new Set([
  "bypass-model",
  "bypass-zero-quota",
  "bypass-opencode-telemetry-unavailable",
  "bypass-effort",
  "bypass-alpha-guardrail",
  "bypass-preset-agent",
  "bypass-usage",
  "non-campaign",
  "empty-worktree",
  "run-custom-harness-to-exit",
  "clear-environment",
  "help",
]);

const FLAG_NAMES = new Set([
  "harness",
  "harness-executable",
  "model",
  "effort",
  "name",
  "supervisor",
  "escalation",
  "role",
  "cwd",
  "prompt",
  "objective-code",
  "empty-worktree",
  "deliverable-shape",
  "requires",
  "non-campaign",
  "run-custom-harness-to-exit",
  "clear-environment",
  "env",
  "stdout-path",
  "stderr-path",
  "exit-status-path",
  "wall-time-path",
  "launcher-evidence-path",
  "timeout-ms",
  "bypass-model",
  "bypass-zero-quota",
  "bypass-opencode-telemetry-unavailable",
  "bypass-effort",
  "bypass-alpha-guardrail",
  "bypass-preset-agent",
  "bypass-usage",
  "help",
]);

/**
 * Flags that USED to exist and were deliberately removed. A bare
 * `unknown flag "--x"` tells a caller that their belief about the tool is
 * wrong but not why, and leaves them to guess whether it is a typo, a
 * version skew, or a decision. Naming the withdrawal turns the refusal into
 * the explanation, which is how every other refusal in this codebase is
 * written.
 */
const WITHDRAWN_FLAGS = new Map<string, string>([
  [
    "bypass-objective-code",
    "was removed on the Lord's order, 2026-08-25. An Alpha or Shadow now " +
      "requires its objective code to exist in the queue table, with no " +
      "exception: a campaign with no queue row is invisible to render-queue " +
      "and to the autoscaler's ready queue while its Alpha still consumes a " +
      "live-Alpha slot, and only the Lord may authorise a row. Ask him to " +
      "have it filed, then relaunch.",
  ],
]);

export function splitPassthroughArgv(args: readonly string[]): {
  throneArgs: string[];
  passthrough?: string[];
} {
  const boundary = args.indexOf("--");
  if (boundary === -1) return { throneArgs: [...args] };
  return {
    throneArgs: args.slice(0, boundary),
    passthrough: args.slice(boundary + 1),
  };
}

export async function harnessExecutableRefusal(
  executable: string,
): Promise<string | undefined> {
  if (!path.isAbsolute(executable)) {
    return `--harness-executable "${executable}" must be an absolute path`;
  }
  let info;
  try {
    info = await stat(executable);
  } catch {
    return `--harness-executable "${executable}" does not exist`;
  }
  if (!info.isFile()) {
    return `--harness-executable "${executable}" is not a regular file`;
  }
  try {
    await access(executable, constants.X_OK);
  } catch {
    return `--harness-executable "${executable}" is not executable`;
  }
  return undefined;
}

export function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument "${arg}" (expected --flag value)`);
    }
    const key = arg.slice(2);
    if (!FLAG_NAMES.has(key)) {
      const withdrawn = WITHDRAWN_FLAGS.get(key);
      throw new Error(
        withdrawn === undefined ? `unknown flag "${arg}"` : `${arg} ${withdrawn}`,
      );
    }
    if (BOOLEAN_FLAGS.has(key)) {
      (flags as Record<string, string | boolean>)[key] = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) throw new Error(`flag "${arg}" needs a value`);
    if (key === "env") {
      flags.env = [...(flags.env ?? []), value];
    } else {
      (flags as Record<string, string | boolean>)[key] = value;
    }
    i++;
  }
  return flags;
}
