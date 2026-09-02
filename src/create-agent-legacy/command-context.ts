import type { CreateAgentOutputDeps } from "./create-agent-contracts.ts";

export function stdoutWriter(
  deps: CreateAgentOutputDeps,
): (text: string) => void {
  return deps.writeStdout ?? ((text) => process.stdout.write(text));
}

export function stderrWriter(
  deps: CreateAgentOutputDeps,
): (text: string) => void {
  return deps.writeStderr ?? ((text) => process.stderr.write(text));
}

export function currentIsoTime(deps: CreateAgentOutputDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}
