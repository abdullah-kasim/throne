import { parseArgs } from "node:util";

export const SEMAPHORE_USAGE = [
  "usage: throne semaphore create <name> --slots <n>",
  "       throne semaphore run <name> -- <command> [args...]",
  "       throne semaphore status [<name>] [--json]",
].join("\n");

const SEMAPHORE_NAME_FORM = /^[A-Za-z0-9-]+$/;
const SLOT_COUNT_FORM = /^[1-9][0-9]*$/;
const COMMAND_BOUNDARY = "--";

export const SemaphoreAction = {
  Help: "help",
  Create: "create",
  Run: "run",
  Status: "status",
} as const;

export type SemaphoreArguments =
  | { readonly action: typeof SemaphoreAction.Help }
  | { readonly action: typeof SemaphoreAction.Create; readonly name: string; readonly slots: number }
  | {
      readonly action: typeof SemaphoreAction.Run;
      readonly name: string;
      readonly command: string;
      readonly commandArguments: readonly string[];
    }
  | { readonly action: typeof SemaphoreAction.Status; readonly name: string | undefined; readonly json: boolean };

export function isSemaphoreName(text: string): boolean {
  return SEMAPHORE_NAME_FORM.test(text);
}

function semaphoreNameOf(text: string | undefined): string {
  if (text === undefined) throw new Error("a semaphore name is required");
  if (!isSemaphoreName(text)) {
    throw new Error(`"${text}" is not a semaphore name: use only ASCII letters, digits and dashes`);
  }
  return text;
}

function slotCountOf(text: string | undefined): number {
  if (text === undefined) throw new Error("create needs --slots <n>");
  const slots = Number(text);
  if (!SLOT_COUNT_FORM.test(text) || !Number.isSafeInteger(slots)) {
    throw new Error(`--slots takes a positive whole number, got "${text}"`);
  }
  return slots;
}

function refuseExtraArguments(action: string, extra: readonly string[]): void {
  if (extra.length > 0) throw new Error(`${action} got unexpected arguments "${extra.join(" ")}"`);
}

export function parseSemaphoreArguments(commandArguments: readonly string[]): SemaphoreArguments {
  const boundary = commandArguments.indexOf(COMMAND_BOUNDARY);
  const ownArguments = boundary === -1 ? commandArguments : commandArguments.slice(0, boundary);
  const wrappedCommand = boundary === -1 ? undefined : commandArguments.slice(boundary + 1);
  const { values, positionals } = parseArgs({
    args: [...ownArguments],
    options: {
      slots: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help === true) return { action: SemaphoreAction.Help };
  const [action, name, ...extra] = positionals;
  if (action !== SemaphoreAction.Create && values.slots !== undefined) throw new Error("--slots belongs to create only");
  if (action !== SemaphoreAction.Status && values.json !== undefined) throw new Error("--json belongs to status only");
  if (action !== SemaphoreAction.Run && wrappedCommand !== undefined) throw new Error('"--" belongs to run only');
  if (action === SemaphoreAction.Create) {
    refuseExtraArguments(action, extra);
    return { action, name: semaphoreNameOf(name), slots: slotCountOf(values.slots) };
  }
  if (action === SemaphoreAction.Run) {
    refuseExtraArguments(action, extra);
    const [command, ...wrappedArguments] = wrappedCommand ?? [];
    if (command === undefined) throw new Error("run needs the command after --: run <name> -- <command> [args...]");
    return { action, name: semaphoreNameOf(name), command, commandArguments: wrappedArguments };
  }
  if (action === SemaphoreAction.Status) {
    refuseExtraArguments(action, extra);
    return { action, name: name === undefined ? undefined : semaphoreNameOf(name), json: values.json === true };
  }
  throw new Error(
    action === undefined ? "an action is required: create, run or status" : `"${action}" is not an action: use create, run or status`,
  );
}
