import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  generationDirPrefix,
  publishStagingAsDist,
  repoRoot,
} from '../../scripts/build-and-publish-dist.mjs';

// Shared choreography for real-process races against `buildAndPublishDist`'s
// publish/prune mechanics -- real, separate OS processes racing on a real
// `dist` symlink, with only the `nest`/`tsc` compile steps faked out (see
// `concurrent-build-runner.mjs`). Used by both `build-and-publish-dist.test.ts`
// (the underlying build-mechanics invariants) and
// `build-and-publish-dist-isolation.test.ts` (the isolation fix's own
// both-classes proof) -- one responsibility (real-process race choreography),
// two distinct sets of tests reading it.

export const concurrentBuildRunnerPath = path.join(repoRoot, 'test', 'fixtures', 'concurrent-build-runner.mjs');

export function fakeArtifactExpectedPaths(generationDir: string): string[] {
  return [
    path.join(generationDir, 'src', 'tools.js'),
    path.join(generationDir, 'test', 'fixtures', 'send-agent-process-mutex-runner.js'),
  ];
}

function generationDirNameOwnedByPid(generationRoot: string, pid: number): string | undefined {
  const ownedByPidPattern = new RegExp(`^${generationDirPrefix}\\d+-${pid}$`);
  return readdirSync(generationRoot).find((entry) => ownedByPidPattern.test(entry));
}

export async function waitForGenerationDirOwnedByPid(
  generationRoot: string,
  pid: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = generationDirNameOwnedByPid(generationRoot, pid);
    if (found) {
      return found;
    }
    await delay(20);
  }
  throw new Error(`no generation directory owned by pid ${pid} appeared within ${timeoutMs}ms`);
}

export function spawnConcurrentBuildRunner(
  runnerPath: string,
  generationRoot: string,
  artifactDelayMs: number,
): ChildProcess {
  return spawn(process.execPath, [runnerPath, String(artifactDelayMs)], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: { ...process.env, THRONE_BUILD_GENERATION_ROOT: generationRoot },
  });
}

export function spawnConcurrentBuildRunnerSync(runnerPath: string, generationRoot: string, artifactDelayMs: number) {
  return spawnSync(process.execPath, [runnerPath, String(artifactDelayMs)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, THRONE_BUILD_GENERATION_ROOT: generationRoot },
  });
}

export function waitForChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
}

export function fabricateGenerationDir(generationRoot: string, generationName: string): void {
  const dir = path.join(generationRoot, generationName);
  for (const artifactPath of fakeArtifactExpectedPaths(dir)) {
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, '// fake build output\n');
  }
  mkdirSync(path.join(dir, 'systemd'), { recursive: true });
}

export function seedInitialGeneration(generationRoot: string): string {
  const generationName = `${generationDirPrefix}${Date.now()}-${process.pid}`;
  fabricateGenerationDir(generationRoot, generationName);
  publishStagingAsDist(generationName, generationRoot);
  return generationName;
}

function alreadyExitedPid(cwd: string): number {
  const exited = spawnSync(process.execPath, ['-e', ''], { cwd });
  if (!exited.pid) throw new Error('the throwaway process must report a pid before its exit can stand in for a dead owner');
  return exited.pid;
}

/**
 * The shared invariant test 1 originally pinned inline: a slower build's
 * in-progress generation directory must survive a faster sibling's prune.
 * Factored out (returning a verdict rather than asserting) so it can be run
 * against different roots/runner scripts, without duplicating the race
 * choreography at each call site.
 */
export async function raceSlowBuildSurvivesFastPrune(
  runnerPath: string,
  generationRoot: string,
): Promise<{ slowSurvived: boolean; slowContentIntact: boolean; fastExitCode: number | null; slowExitCode: number | null }> {
  const slowBuild = spawnConcurrentBuildRunner(runnerPath, generationRoot, 2_000);
  const slowBuildExitCode = waitForChildExit(slowBuild);
  const slowGenerationDirName = await waitForGenerationDirOwnedByPid(generationRoot, slowBuild.pid!, 1_000);
  const slowGenerationDir = path.join(generationRoot, slowGenerationDirName);

  const fastBuild = spawnConcurrentBuildRunnerSync(runnerPath, generationRoot, 0);

  const slowSurvived = readdirSync(generationRoot).includes(slowGenerationDirName);
  const slowExitCode = await slowBuildExitCode;
  const slowContentIntact =
    slowSurvived &&
    fakeArtifactExpectedPaths(slowGenerationDir).every(
      (artifactPath) => existsSync(artifactPath) && readFileSync(artifactPath, 'utf8') === '// fake build output\n',
    );

  return { slowSurvived, slowContentIntact, fastExitCode: fastBuild.status, slowExitCode };
}

/**
 * Runs test 2's exact first/middle/last build sequence, invoking `onMiddleSettled`
 * once the middle build has published, exited, and pruned -- but before the
 * last build starts. This is invocation B's real, in-flight build sequence;
 * the hook is where invocation A (racing concurrently, sharing the root) gets
 * to act between B's builds, mirroring TWR's actual interleaving rather than
 * fighting B's own bookkeeping on every tick.
 */
export async function runTest2LikeSequenceWithMiddleHook(
  runnerPath: string,
  generationRoot: string,
  onMiddleSettled: () => void,
): Promise<string[]> {
  const violations: string[] = [];
  const firstBuild = spawnConcurrentBuildRunnerSync(runnerPath, generationRoot, 0);
  if (firstBuild.status !== 0) violations.push(`first build exited ${firstBuild.status}`);

  const middleBuild = spawnConcurrentBuildRunner(runnerPath, generationRoot, 0);
  const middleExit = await waitForChildExit(middleBuild);
  if (middleExit !== 0) violations.push(`middle build exited ${middleExit}`);

  onMiddleSettled();

  const lastBuild = spawnConcurrentBuildRunnerSync(runnerPath, generationRoot, 0);
  if (lastBuild.status !== 0) violations.push(`last build exited ${lastBuild.status}`);
  return violations;
}

/**
 * Seeds a generation whose protections are already exhausted (dead owner
 * pid, timestamp past the grace window, and enough more-recent padding
 * generations to push it out of the count floor's top 5) and publishes it as
 * `dist` -- the state a generation naturally reaches partway through a real,
 * longer-running suite. Returns its name.
 */
export function seedStaleUnprotectedGeneration(generationRoot: string): string {
  const deadPid = alreadyExitedPid(generationRoot);
  const staleTimestamp = Date.now() - 61_000; // already past the 30s grace window
  const staleGenerationName = `${generationDirPrefix}${staleTimestamp}-${deadPid}`;
  fabricateGenerationDir(generationRoot, staleGenerationName);
  publishStagingAsDist(staleGenerationName, generationRoot);
  // Padding: 5 generations more recent than the stale one (but still owned by
  // the same already-exited pid) so the count floor's "keep the 5 most
  // recent" cannot cover the stale one once fresh builds also exist.
  for (let index = 0; index < 5; index += 1) {
    fabricateGenerationDir(generationRoot, `${generationDirPrefix}${staleTimestamp + 1_000 + index}-${deadPid}`);
  }
  return staleGenerationName;
}
