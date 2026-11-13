import { spawn } from "node:child_process";
import os from "node:os";

const COMMAND_NOT_STARTED_EXIT_CODE = 127;
const SIGNAL_EXIT_CODE_BASE = 128;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface CommandToRun {
  readonly command: string;
  readonly commandArguments: readonly string[];
}

export interface CommandWatchers {
  readonly started: (pid: number) => Promise<void>;
  readonly couldNotStart: (error: Error) => void;
}

function exitCodeOfEndedCommand(code: number | null, signal: NodeJS.Signals | null): number {
  return signal === null ? (code ?? 0) : SIGNAL_EXIT_CODE_BASE + os.constants.signals[signal];
}

export function runCommandHoldingSlot(toRun: CommandToRun, watchers: CommandWatchers): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(toRun.command, [...toRun.commandArguments], {
      stdio: "inherit",
      detached: true,
    });
    const forwardToCommand = (signal: NodeJS.Signals): void => void child.kill(signal);
    const stopForwarding = (): void => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forwardToCommand);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forwardToCommand);
    let recording = Promise.resolve();
    child.once("spawn", () => {
      if (child.pid !== undefined) recording = watchers.started(child.pid);
    });
    child.once("error", (error) => {
      stopForwarding();
      watchers.couldNotStart(error);
      resolve(COMMAND_NOT_STARTED_EXIT_CODE);
    });
    child.once("exit", (code, signal) => {
      stopForwarding();
      void recording.then(() => resolve(exitCodeOfEndedCommand(code, signal)));
    });
  });
}
