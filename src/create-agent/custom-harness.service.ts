import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { open, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { listTabs } from '../herdr/herdr-runtime.service.ts';
import { HerdrTabService } from '../herdr/herdr-tab.service.ts';
import { closeTab, createTab } from '../herdr/herdr-tab.service.ts';
import type {
  CustomHarnessOneShotOptions,
  CustomHarnessOneShotResult,
  RunCustomHarnessOneShotDeps,
} from '../herdr/herdr-create.service.ts';
import type {
  CreateAgentOutputDeps,
  CustomHarnessRequest,
} from './create-agent-contracts.ts';
import { stderrWriter, stdoutWriter } from './command-context.ts';

const RUN_CUSTOM_HARNESS_ONE_SHOT_DEPS: RunCustomHarnessOneShotDeps = {
  listTabs,
  createTab,
  runChild: runCustomHarnessChild,
  evidenceExists: existsSync,
  readEvidence: readFileSync,
  now: Date.now,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  closeTab,
};

async function runCustomHarnessChild(
  options: CustomHarnessOneShotOptions,
): Promise<void> {
  const stdout = await open(options.stdoutPath, 'w');
  const stderr = await open(options.stderrPath, 'w');
  const startedAt = Date.now();
  const child = spawn(options.executable, options.argv, {
    cwd: options.cwd,
    env: options.environment,
    detached: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
  }, options.timeoutMs);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve(code ?? (signal === null ? 1 : 128)),
    );
  });
  clearTimeout(timer);
  if (timedOut) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }
  await Promise.all([stdout.close(), stderr.close()]);
  const wallTimeMs = Date.now() - startedAt;
  await writeFile(options.exitStatusPath, `${timedOut ? 124 : exitCode}\n`);
  await writeFile(options.wallTimePath, `${wallTimeMs}\n`);
  const temporaryEvidencePath = `${options.launcherEvidencePath}.tmp-${process.pid}`;
  await writeFile(
    temporaryEvidencePath,
    JSON.stringify({
      mode: 'custom-harness-one-shot',
      requested_executable: options.executable,
      resolved_executable: realpathSync(options.executable),
      argv: options.argv,
      cwd: options.cwd,
      environment_keys: Object.keys(options.environment).sort(),
      timeout_ms: options.timeoutMs,
      timed_out: timedOut,
      exit_code: timedOut ? null : exitCode,
      wall_time_ms: wallTimeMs,
      policy: options.policy,
    }, null, 2) + '\n',
  );
  await rename(temporaryEvidencePath, options.launcherEvidencePath);
}

/** Injectable owner for the bounded custom one-shot harness lifecycle. */
export class CustomHarnessService {
  private readonly herdrTabs: HerdrTabService;

  constructor(herdrTabs = new HerdrTabService()) {
    this.herdrTabs = herdrTabs;
  }

  async run(request: CustomHarnessRequest, deps: CreateAgentOutputDeps): Promise<number> {
    const flags = request.flags;
    const writeStdout = stdoutWriter(deps);
    const writeStderr = stderrWriter(deps);
    const environment = Object.fromEntries(
      ((flags.env as string[] | undefined) ?? []).map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    try {
      const result = await this.runOneShot({
        name: request.name,
        cwd: request.cwd,
        executable: request.requestedExecutable!,
        argv: request.passthrough ?? [],
        environment,
        stdoutPath: flags['stdout-path'] as string,
        stderrPath: flags['stderr-path'] as string,
        exitStatusPath: flags['exit-status-path'] as string,
        wallTimePath: flags['wall-time-path'] as string,
        launcherEvidencePath: flags['launcher-evidence-path'] as string,
        timeoutMs: Number(flags['timeout-ms']),
        policy: {
          harness: request.launchHarness,
          model: request.launchModel,
          effort: request.launchEffort,
        },
      });
      writeStdout(
        `Ran custom harness to exit in visible tab "${request.name}" via ${request.launchHarness} ` +
          `[${request.launchModel} / effort ${request.launchEffort}] — ` +
          `${result.timedOut ? 'timed out' : `exit ${result.exitCode}`} after ` +
          `${result.wallTimeMs}ms; tab closed.\n`,
      );
      return result.timedOut ? 124 : result.exitCode;
    } catch (error) {
      writeStderr(
        `create-agent: custom harness one-shot launch failed for "${request.name}" ` +
          `(${error instanceof Error ? error.message : String(error)}).\n`,
      );
      return 1;
    }
  }

  async runOneShot(
    options: CustomHarnessOneShotOptions,
    deps: RunCustomHarnessOneShotDeps = {
      ...RUN_CUSTOM_HARNESS_ONE_SHOT_DEPS,
      createTab: this.herdrTabs.createTab.bind(this.herdrTabs),
      closeTab: this.herdrTabs.closeTab.bind(this.herdrTabs),
    },
  ): Promise<CustomHarnessOneShotResult> {
    const existing = (await deps.listTabs()).filter(
      (tab) => tab.label === options.name,
    );
    if (existing.length > 0) {
      throw new Error(
        `a Herdr tab named "${options.name}" already exists; refusing a duplicate one-shot launch`,
      );
    }
    const scratchRoot = path.join(os.homedir(), 'tmp');
    mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(
      path.join(scratchRoot, 'throne-custom-harness-'),
    );
    const { tabId } = await deps.createTab(options.name, options.cwd);
    try {
      await deps.runChild(options);
      const deadline = deps.now() + options.timeoutMs + 5000;
      let lastParseFailure = 'evidence file was not present';
      while (deps.now() < deadline) {
        if (deps.evidenceExists(options.launcherEvidencePath)) {
          try {
            const evidence = JSON.parse(
              deps.readEvidence(options.launcherEvidencePath, 'utf8'),
            ) as {
              exit_code: number | null;
              timed_out: boolean;
              wall_time_ms: number;
            };
            return {
              exitCode: evidence.exit_code ?? 124,
              timedOut: evidence.timed_out,
              wallTimeMs: evidence.wall_time_ms,
            };
          } catch (error) {
            lastParseFailure = error instanceof Error ? error.message : String(error);
          }
        }
        await deps.sleep(25);
      }
      throw new Error(
        `launcher evidence "${options.launcherEvidencePath}" was not parseable before the bounded wait expired; last parse failure: ${lastParseFailure}`,
      );
    } finally {
      await deps.closeTab(tabId).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
