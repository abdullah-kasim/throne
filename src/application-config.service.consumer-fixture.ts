// Shared test-support seam for the roleplay-preset proof specs
// (`application-config.service.consumer-regression.spec.ts`,
// `agentdata/identity-data.service.preset-invariance.spec.ts`). Not a spec
// file itself — it builds a scratch live-throne-root fixture (mirroring the
// pattern `application-config.service.spec.ts` already uses for its
// worktree-vs-live-root test) and spawns
// `application-config.service.consumer-probe.driver.mjs` against it, so each
// proof observes a REAL, process-isolated `PERSONA_CONFIG` resolution
// (the module-level singleton is resolved once per process) rather than a
// hand-constructed `PersonaConfig` bypassing the loader.

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import type { PersonaConfig } from './application-config.service.ts';

const execFileAsync = promisify(execFile);

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = path.join(
  SRC_DIR,
  'application-config.service.consumer-probe.driver.mjs',
);
const REGISTER_TYPESCRIPT_PATH = path.join(
  SRC_DIR,
  '..',
  'test',
  'register-typescript.mjs',
);

interface PromptCapture {
  name: string;
  prompt: string;
}

interface DeriveShadowNameCapture {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Every value the driver reports back, one field per real production call
 *  site it exercised. Shared shape so the two spec files assert against the
 *  same contract. */
export interface PersonaConsumerProbeResult {
  personaConfig: PersonaConfig;
  identityText: string;
  composeOpeningPrompt: string;
  roleStandingInstructionAlpha: string;
  composeCodexOpeningPrompt: string;
  roleNameFor: string;
  buildResumePrompt: string;
  buildExactResumePrompt: PromptCapture;
  resurrectPrompt: PromptCapture;
  lordNotificationTitle: string;
  canonicalShadowName: { ok: true; name: string } | { ok: false; reason: string };
  deriveShadowName: DeriveShadowNameCapture;
  classifyPlanRoleAlpha: string;
  classifyPlanRoleShadowSlice99: string;
  classifyPlanRoleShadowOrdinary: string;
  isShadowSlice99Name: boolean;
  findFullyIdleFamilies: readonly { alpha: string; idleChildren: readonly string[] }[];
}

/** Builds a scratch git repo whose live throne root (per
 *  `resolveLiveThroneRoot`'s `dirname(git-common-dir)` contract — the git
 *  repository root itself, with no `'throne'` subdirectory appended) holds
 *  either no `config.user.ts` (the absent-file/Default case) or a fixture one
 *  this caller supplies. Returns the directory to resolve the live root
 *  FROM — i.e. the fixture's process.cwd() — not the live root itself. */
export async function fixtureLiveThroneRootCwd(
  t: TestContext,
  userConfigSource?: string,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'persona-consumer-probe-'));
  t.after(async () => {
    await execFileAsync('rm', ['-rf', root]).catch(() => {});
  });
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync(
    'git',
    ['commit', '--quiet', '--allow-empty', '-m', 'root'],
    {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Persona Consumer Probe',
        GIT_AUTHOR_EMAIL: 'persona-consumer-probe@example.test',
        GIT_COMMITTER_NAME: 'Persona Consumer Probe',
        GIT_COMMITTER_EMAIL: 'persona-consumer-probe@example.test',
      },
    },
  );
  if (userConfigSource !== undefined) {
    // `config.user.ts` is loaded via dynamic `import()`; Node decides a
    // `.ts` file's module kind from the nearest `package.json`, so a sibling
    // one pins it to ESM (mirrors `application-config.service.spec.ts`'s
    // `writeUserConfigFixture`).
    await writeFile(
      path.join(root, 'package.json'),
      '{ "type": "module" }\n',
    );
    await writeFile(
      path.join(root, 'config.user.ts'),
      userConfigSource,
    );
  }
  return root;
}

/** Spawns the real production driver against `fixtureCwd` and returns its
 *  parsed report. Each call is a fresh Node process — the only way to observe
 *  a different resolved `PERSONA_CONFIG` singleton per fixture within one
 *  test run. */
export async function runPersonaConsumerProbe(
  fixtureCwd: string,
): Promise<PersonaConsumerProbeResult> {
  // `resolveLiveThroneRoot()`'s zero-arg call (the shape every production
  // call site, including `application-config.service.ts`'s module-load-time
  // `PERSONA_CONFIG` singleton, actually uses) resolves to
  // `RUNTIME_THRONE_ROOT` — anchored to the running module's own on-disk
  // location, never to `process.cwd()`. The driver's `process.chdir()` can
  // no longer steer that resolution, so this probe instead uses
  // `THRONE_LIVE_ROOT`, which is checked FIRST and short-circuits before
  // `RUNTIME_THRONE_ROOT` is ever consulted: set it explicitly to
  // `fixtureCwd` so the spawned child's zero-arg resolution observes this
  // fixture's scratch root, without touching real cwd/git logic at all.
  // This is exactly `THRONE_LIVE_ROOT`'s contract — an explicit override —
  // not an accident of git-rev-parse-from-cwd.
  const childEnv = { ...process.env, THRONE_LIVE_ROOT: fixtureCwd };
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', REGISTER_TYPESCRIPT_PATH, DRIVER_PATH, fixtureCwd],
    { cwd: SRC_DIR, maxBuffer: 8 * 1024 * 1024, env: childEnv },
  );
  return JSON.parse(stdout) as PersonaConsumerProbeResult;
}
