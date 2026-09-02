import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

type TargetTestRun = {
  combined: string;
  succeeded: boolean;
};

/**
 * Counts top-level `test(` declarations in a source file, the file's stated
 * contract for how many tests `node --test` should report when run in
 * isolation.
 */
export function countDeclaredTests(sourcePath: string): number {
  const source = readFileSync(sourcePath, "utf8");
  const matches = source.match(/^test\(/gm);
  return matches ? matches.length : 0;
}

/**
 * Runs a single test file as an isolated `node --test` child process and
 * returns the number of tests it reported. `repoRoot` is the cwd the child
 * process runs from; `relativeTargetPath` is the file to run, relative to
 * that root.
 */
export async function countReportedTests(
  repoRoot: string,
  relativeTargetPath: string,
): Promise<number> {
  const args = [
    "--import",
    "./test/register-typescript.mjs",
    "--test",
    "--test-concurrency=0",
    relativeTargetPath,
  ];
  // Node's test runner refuses to nest itself: it detects NODE_TEST_CONTEXT
  // in the environment and skips running the child's files entirely. Strip
  // it so the spawned `node --test` actually runs the target file.
  const { NODE_TEST_CONTEXT: _unused, ...childEnv } = process.env;
  const runTarget = async (): Promise<TargetTestRun> => {
    try {
      const result = await execute(process.execPath, args, { cwd: repoRoot, env: childEnv });
      return { combined: `${result.stdout}${result.stderr}`, succeeded: true };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return {
        combined: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
        succeeded: false,
      };
    }
  };

  const first = await runTarget();
  const measured = first.succeeded ? first : await runTarget();
  if (!measured.succeeded) {
    throw new Error(
      `target test failed twice; no reported count is attributable to ${relativeTargetPath}:\n` +
        `first run:\n${first.combined}\nretry:\n${measured.combined}`,
    );
  }
  // Node's test runner picks its summary line's prefix by reporter (TAP's
  // bare "#", the default "spec" reporter's "ℹ") depending on whether stdout
  // is a TTY; accept either so the guard is robust to both.
  const summary = measured.combined.match(/^(?:#|ℹ) tests (\d+)$/m);
  if (!summary) {
    throw new Error(
      `expected a TAP "# tests N" summary line in child process output, got:\n${measured.combined}`,
    );
  }
  return Number(summary[1]);
}

export type CandidateTestReport = {
  relativePath: string;
  declared: number;
  reported: number;
};

/**
 * Measures candidates one at a time so a result cannot be changed by process
 * pressure from the guard's other candidate runners.
 */
export async function measureCandidateTestReports(
  repoRoot: string,
  relativeTargetPaths: readonly string[],
  measureReportedTests = countReportedTests,
): Promise<CandidateTestReport[]> {
  const results: CandidateTestReport[] = [];
  for (const relativePath of relativeTargetPaths) {
    const declared = countDeclaredTests(`${repoRoot}${relativePath}`);
    const reported = await measureReportedTests(repoRoot, relativePath);
    results.push({ relativePath, declared, reported });
  }
  return results;
}
