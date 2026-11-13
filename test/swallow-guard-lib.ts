import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

type TargetTestRun = {
  combined: string;
  succeeded: boolean;
};

export function countDeclaredTests(sourcePath: string): number {
  const source = readFileSync(sourcePath, "utf8");
  const matches = source.match(/^test\(/gm);
  return matches ? matches.length : 0;
}

export async function countReportedTests(
  repoRoot: string,
  relativeTargetPath: string,
): Promise<number> {
  const args = ["test", `./${relativeTargetPath}`];
  const runTarget = async (): Promise<TargetTestRun> => {
    try {
      const result = await execute(process.execPath, args, { cwd: repoRoot });
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
  const summary = measured.combined.match(/^Ran (\d+) tests? across/m);
  if (!summary) {
    throw new Error(
      `expected a "Ran N tests" summary line in child process output, got:\n${measured.combined}`,
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
