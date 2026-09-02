import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CliInvocationResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CliInvocationOutcome =
  | { readonly outcome: 'success'; readonly result: CliInvocationResult }
  | { readonly outcome: 'retryable-failure-exhausted'; readonly lastResult: CliInvocationResult }
  | { readonly outcome: 'failure'; readonly result: CliInvocationResult };

/**
 * A `throne-cli`-fronted invocation's stderr, when it fails at the module-
 * load stage (build skew mid-swap being the known cause -- see
 * `tools.ts`'s `runEntrypoint`), is one JSON line carrying `retryable:
 * true`. This is the ONLY signal this function inspects; it builds no
 * workaround for that specific known transient (out of scope per this
 * slice's contract) -- it just honors the generic flag.
 */
function stderrSignalsRetryable(stderr: string): boolean {
  return stderr
    .split('\n')
    .filter((line) => line.trim() !== '')
    .some((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { retryable?: unknown }).retryable === true
        );
      } catch {
        return false;
      }
    });
}

async function runOnce(
  executablePath: string,
  argv: readonly string[],
): Promise<CliInvocationResult> {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, [...argv], {
      encoding: 'utf8',
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const execError = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: execError.code ?? 1,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
    };
  }
}

/**
 * Runs a `throne-cli`-fronted command, honoring its `retryable: true`
 * stderr signal: on a retryable failure, retries exactly once; on two
 * CONSECUTIVE retryable failures, treats it as genuinely broken and returns
 * `retryable-failure-exhausted` rather than silently reading as "nothing to
 * spawn" -- the caller is responsible for logging that outcome loudly. A
 * non-retryable failure returns `failure` immediately, no retry.
 */
export async function invokeThroneCliWithRetry(
  executablePath: string,
  argv: readonly string[],
  run: (
    executablePath: string,
    argv: readonly string[],
  ) => Promise<CliInvocationResult> = runOnce,
): Promise<CliInvocationOutcome> {
  const first = await run(executablePath, argv);
  if (first.exitCode === 0) return { outcome: 'success', result: first };
  if (!stderrSignalsRetryable(first.stderr)) {
    return { outcome: 'failure', result: first };
  }

  const second = await run(executablePath, argv);
  if (second.exitCode === 0) return { outcome: 'success', result: second };
  if (!stderrSignalsRetryable(second.stderr)) {
    return { outcome: 'failure', result: second };
  }

  return { outcome: 'retryable-failure-exhausted', lastResult: second };
}
