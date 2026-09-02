// Forwards SIGINT/SIGTERM from this process to a detached child process
// group and classifies a signal-caused exit as its own error type — a
// distinct concern from composing and running the suite itself: this module
// owns forwarded-child signal reporting, separate from suite orchestration.
import { spawn } from "node:child_process";

export class SuiteSignalError extends Error {
  constructor(signal) {
    super(`run-suite-container: interrupted by ${signal}`);
    this.name = "SuiteSignalError";
    this.signal = signal;
  }
}

export function findSuiteSignal(error) {
  if (error instanceof SuiteSignalError) return error.signal;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const signal = findSuiteSignal(nested);
      if (signal) return signal;
    }
  }
  return undefined;
}

// `onOutput`, when supplied, switches the child's stdout/stderr from
// "inherit" to piped, relays every chunk to this process's own stdout/stderr
// as it arrives (so the child's output still streams live to whoever is
// watching this process), and additionally hands each chunk to `onOutput`
// for the caller to inspect — e.g. to confirm the child's own reported
// summary after it exits, without buffering or delaying the passthrough.
export function runChildWithSignalForwarding(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { onOutput, ...spawnOptions } = options;
    const stdio = onOutput ? ["inherit", "pipe", "pipe"] : spawnOptions.stdio;
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio,
      detached: true,
    });
    if (onOutput) {
      const relay = (stream, sink) => {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          sink.write(chunk);
          onOutput(chunk);
        });
      };
      relay(child.stdout, process.stdout);
      relay(child.stderr, process.stderr);
    }
    let receivedSignal;
    const forward = (signal) => {
      if (receivedSignal) return;
      receivedSignal = signal;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const removeHandlers = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      removeHandlers();
      reject(error);
    });
    child.once("close", (status, childSignal) => {
      removeHandlers();
      const signal = receivedSignal ?? childSignal;
      if (signal) reject(new SuiteSignalError(signal));
      else resolve(status ?? 1);
    });
  });
}
