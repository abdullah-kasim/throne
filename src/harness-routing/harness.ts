// Maps a portable (harness, model, effort) launch request to the concrete
// launcher argv. The Nest Herdr creation owner quotes it into a generated launch
// script and runs it inside an already-created pane (`herdr pane run <pane>
// bash <script>`), then claims the name; the harness is started by the shell
// in the pane, not by `herdr agent start`. Every
// spawned harness goes through the yolo launchers `claudey` / `codexy` /
// `opencodey` (Lord's ruling) so it gets repo checkpoint backups + recovery —
// never the raw `claude` / `codex` / `opencode` binaries. The throne owns
// those launchers under `throne/bin/`, so a spawn names them by absolute path;
// see throne/agent_docs/launchers.md.
//
// Effort is the portable 1–6 scale from MODEL_POLICY.md; its provider spelling
// is translated to a launch token only here, at the spawn boundary. See
// throne/agent_docs/MODEL_POLICY.md. opencode has no native effort flag, so its
// launch argv carries no effort token and its EFFORT_TOKENS row is empty.

import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { RUNTIME_THRONE_ROOT } from '../shared-policy/runtime-throne-root.ts';
import {
  OMNI_MODEL_SLUGS,
  isOmniHarness,
  omniProviderModel,
  omniRuntimeHarness,
} from './omni-harness.ts';
import { MODEL_REGISTRY, registryEntry } from './model-registry.ts';
import {
  deriveHarnessAvailability,
  resolveModelAlias,
} from './registry-derivation.ts';
import {
  HARNESS_NAMES,
  HARNESSES,
  MODEL_NAMES,
  type Harness,
  type RuntimeHarness,
} from './harness-identity.ts';

export { HARNESS_NAMES, HARNESSES, MODEL_NAMES, type Harness, type RuntimeHarness };

export const HARNESS_EXECUTABLE_NAMES: Readonly<
  Record<Harness, readonly string[]>
> = {
  [HARNESS_NAMES.CLAUDE]: [
    'claude',
    'claude-code',
    'claudey',
    'claudey-all',
  ],
  [HARNESS_NAMES.CODEX]: ['codex', 'codexy'],
  [HARNESS_NAMES.OPENCODE]: ['opencode', 'opencodey'],
  // The installed `omp` binary is a bun-run script (`~/.bun/bin/omp` →
  // `.../pi-coding-agent/dist/cli.js`); its OWN OS process reports as `bun`,
  // not `omp` — confirmed by inspecting a live launch's `/proc/<pid>/comm`.
  // `bun` is too generic/shared with unrelated processes to serve as an
  // exclusive pane-executable match, so it is deliberately left off this
  // list; slice 05 (composer/screen observation) inherits this finding.
  [HARNESS_NAMES.OMP]: ['omp', 'ompy'],
  [HARNESS_NAMES.CLAUDEY_ALL_OMNI]: ['claudey-all-omni'],
  [HARNESS_NAMES.CODEXY_ALL_OMNI]: ['codexy-all-omni'],
};

export function runtimeHarness(harness: Harness): RuntimeHarness {
  return isOmniHarness(harness) ? omniRuntimeHarness(harness) : harness;
}

export interface HarnessProcessEvidence {
  name: string;
  argv: readonly string[];
}

const CODEX_NPM_WRAPPER_EXECUTABLE = 'codex-npm-current';
const CODEX_NPM_WRAPPER_EXECUTABLE_TRUNCATED_TO_LINUX_COMM_LIMIT =
  'codex-npm-curre';

function executableBaseName(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function processNameIsCodexNpmWrapper(name: string): boolean {
  const observedName = executableBaseName(name);
  return (
    observedName === CODEX_NPM_WRAPPER_EXECUTABLE ||
    observedName === CODEX_NPM_WRAPPER_EXECUTABLE_TRUNCATED_TO_LINUX_COMM_LIMIT
  );
}

function argvZeroIsCodexNpmWrapper(argv: readonly string[]): boolean {
  return executableBaseName(argv[0] ?? '') === CODEX_NPM_WRAPPER_EXECUTABLE;
}

export function isCodexNpmWrapperProcess(
  process: HarnessProcessEvidence,
): boolean {
  return (
    processNameIsCodexNpmWrapper(process.name) &&
    argvZeroIsCodexNpmWrapper(process.argv)
  );
}

/**
 * The launchers the throne owns under `bin/`. `claudey-all` is deliberately not
 * one of them: it is legacy CLIProxyAPI compatibility that the stow package
 * still provides, so it stays a bare PATH-resolved name.
 */
export type ThroneLauncher = 'claudey' | 'codexy' | 'opencodey' | 'ompy';

/** `<throne>/bin` — the `bin/` sibling of this file's `src/` directory. */
const DEFAULT_LAUNCHER_DIR = path.join(RUNTIME_THRONE_ROOT, 'bin');

/**
 * Absolute path to one throne-owned launcher. The directory is
 * `THRONE_LAUNCHER_DIR` when that variable holds a non-empty value, else the
 * `bin/` beside this file — so a worktree's `tools.ts` spawns through that
 * worktree's own launchers, and a hermetic test can point spawns at a stub
 * directory without putting anything on `PATH`. Read per call, never cached, so
 * the override applies to whatever the environment says at spawn time.
 */
export function throneLauncherPath(launcher: ThroneLauncher): string {
  const overrideDir = process.env.THRONE_LAUNCHER_DIR?.trim();
  return path.join(
    overrideDir ? path.resolve(overrideDir) : DEFAULT_LAUNCHER_DIR,
    launcher,
  );
}

/** A portable launch request: which harness, which model, how hard it thinks. */
export interface HarnessRequest {
  harness: Harness;
  /** Model alias/slug, e.g. `opus-4.8` (claude) or `gpt-5.6-sol` (codex). */
  model: string;
  /** Portable effort score, 1–6 (MODEL_POLICY's scale). */
  effort: number;
}

/**
 * The portable effort score → provider launch token, per MODEL_POLICY's
 * "Portable effort score" table. Index by score (1–6); index 0 is unused.
 */
const EFFORT_TOKENS: Readonly<Record<RuntimeHarness, readonly string[]>> = {
  //          1        2         3       4        5      6
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  codex: ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  // opencode has no native effort flag: the row exists only to satisfy the
  // table contract, and no launch path emits a token from it.
  opencode: ['', '', '', '', '', '', ''],
  // omp's `--thinking` tokens (confirmed via `omp --help`): off, minimal,
  // low, medium, high, xhigh, max, auto. The portable scale never emits
  // 'off'/'minimal'/'auto' — index 1 starts at 'low', mirroring the
  // claude/codex rows above. omp has no ultracode/ultra analogue for
  // effort-6, so it clamps to omp's own top rung, 'max'. Per-model caps
  // (claude-opus-5 has no 'minimal' rung; gpt-5.4/gpt-5.4-mini/gpt-5.5 cap at
  // 'xhigh' with no 'max') need no separate clamp here: the portable scale
  // never requests 'minimal', and those three GPT models' own registered
  // `effort.max: 4` (model-registry.ts) already stops a caller from reaching
  // level 5/6 — `effortToken` is only ever called with an effort inside the
  // model's registered range.
  omp: ['', 'low', 'medium', 'high', 'xhigh', 'max', 'max'],
};

const MIN_EFFORT = 1;
const MAX_EFFORT = 6;

/** Translate a numeric effort score to the harness's launch token. */
export function effortToken(harness: Harness, effort: number): string {
  if (!Number.isInteger(effort) || effort < MIN_EFFORT || effort > MAX_EFFORT) {
    throw new Error(
      `effort must be an integer ${MIN_EFFORT}–${MAX_EFFORT} (got ${effort})`,
    );
  }
  return EFFORT_TOKENS[runtimeHarness(harness)][effort]!;
}

const REGISTRY_HARNESS_AVAILABILITY = deriveHarnessAvailability(MODEL_REGISTRY);
// THE ANTHROPIC-NATIVE MODELS, and deliberately NOT derived from a `claude`
// primary harness. Since 2026-08-27 fable/opus/sonnet/haiku carry an `omp`
// primary so they infer omp by default, which emptied this set when it was
// `harness === CLAUDE` — and an empty set made `isGptModel("fable")` return
// TRUE, which swallowed every claude/Anthropic pair into
// `LEGACY_RESUME_ONLY_MODEL_PAIRS`, removed them from
// `CONFIGURED_MODEL_PAIRS`, and killed config load for any preset naming one
// (measured: `Invalid config.user.ts steering entry "SonnetLow"`). It also
// mis-routed a claude resume of fable to `claudey-all` instead of `claudey`.
//
// The discriminator that survives a primary move: a model available under
// `claude` but NOT under `codex`. Every GPT row is codex-available by
// construction (sol/terra/luna are codex-primary), and no Anthropic model is.
const PRIMARY_CLAUDE_MODELS = new Set(
  REGISTRY_HARNESS_AVAILABILITY[HARNESS_NAMES.CLAUDE].filter(
    (model) =>
      !REGISTRY_HARNESS_AVAILABILITY[HARNESS_NAMES.CODEX].includes(model),
  ),
);

/**
 * Legacy Claude-harness GPT models served by CLIProxyAPI via `claudey-all` —
 * every model available under `claude` (per the registry's `harnessAliases`)
 * whose own primary harness isn't `claude`. They remain valid here so exact
 * stored registrations, standalone/manual launcher calls, and the configured
 * ClaudeCode fresh-GPT route can be reconstructed. Fresh throne GPT
 * registration is admitted only on the harness selected by create-agent's
 * forward-policy guard.
 */
const CLAUDE_GPT_MODELS: readonly string[] = REGISTRY_HARNESS_AVAILABILITY[
  HARNESS_NAMES.CLAUDE
].filter((model) => !PRIMARY_CLAUDE_MODELS.has(model));

/**
 * Whether `model` (a canonical registry slug, as returned by `resolveModel`) is
 * one of the legacy Claude/GPT models the `claudey-all` launcher serves. A
 * stored `claude` recipe uses CLIProxyAPI; the same slug on native `codex` goes
 * through `codexy`.
 */
export function isGptModel(model: string): boolean {
  return CLAUDE_GPT_MODELS.includes(model);
}

/**
 * Every `OMNI_MODEL_SLUGS` entry (the external Omni manifest's executor
 * slugs) must name a `MODEL_REGISTRY` model, so a manifest entry can never
 * silently point the omni launchers at a model the registry has no record of
 * at all. Throws naming the offending slug at module load if the manifest
 * drifts. Does not additionally require `enabled`: the omni manifest is
 * legacy-resume/manual-launch surface that may legitimately still name a
 * model the registry disabled for fresh spawns but still recognizes.
 */
function assertOmniSlugsResolveToRegistryModels(
  omniSlugs: readonly string[],
): void {
  for (const slug of omniSlugs) {
    if (registryEntry(slug) === undefined) {
      throw new Error(
        `Omni model manifest names "${slug}", which is not a MODEL_REGISTRY model`,
      );
    }
  }
}
assertOmniSlugsResolveToRegistryModels(OMNI_MODEL_SLUGS);

/**
 * The canonical model slugs the throne may launch under `harness` — derived
 * from `MODEL_REGISTRY`, the throne's single hand-authored model vocabulary.
 * Any slug outside this set (after alias mapping) is rejected BEFORE
 * spawning, so a bad `--model` never silently fails inside an already-
 * launched harness (the `create-agent --model opus-4.8` bug). The omni
 * harnesses keep reading the external Omni manifest (`OMNI_MODEL_SLUGS`)
 * directly — that surface is legacy-resume/manual-launch only under the
 * active forward policy and isn't registry-shaped duplication; the
 * consistency check above ties it back to registry identity. The sole
 * accessor for per-harness availability — callers never destructure/iterate
 * a raw literal.
 */
export function modelsForHarness(harness: Harness): readonly string[] {
  if (isOmniHarness(harness)) {
    return OMNI_MODEL_SLUGS;
  }
  const models = REGISTRY_HARNESS_AVAILABILITY[harness];
  if (models === undefined) {
    throw new Error(`modelsForHarness: unrecognized harness "${harness}"`);
  }
  return models;
}

/**
 * Resolve a caller-supplied model alias/slug to a canonical registry slug for
 * `harness`, validating it in the process. Trims, matches case-insensitively,
 * resolves known aliases (e.g. `opus-4.8`→`opus`) through `MODEL_REGISTRY`'s
 * own `aliases`/`harnessAliases` fields via `resolveModelAlias` — never by
 * reading those fields structurally here — and returns the canonical slug.
 * An omni harness resolves the same short names its underlying runtime
 * harness does (`claudey-all-omni`/`codexy-all-omni` share `claude`/`codex`'s
 * `harnessAliases` rows, e.g. `sol`/`terra`) rather than restating them.
 * Throws a clear `Error` naming the valid slugs when the model is unknown —
 * the single pre-spawn gate that stops an invalid `--model` from silently
 * failing inside a launched harness. Idempotent: a canonical slug resolves to
 * itself.
 */
export function resolveModel(harness: Harness, model: string): string {
  const key = model.trim().toLowerCase();
  const valid = modelsForHarness(harness);
  const canonical = valid.find((m) => m === key);
  if (canonical !== undefined) {
    return canonical;
  }
  const aliased = resolveModelAlias(
    MODEL_REGISTRY,
    isOmniHarness(harness) ? omniRuntimeHarness(harness) : harness,
    key,
  );
  if (aliased !== undefined) {
    return aliased;
  }
  throw new Error(`unknown ${harness} model "${model}" — valid slugs: ${valid.join(', ')}`);
}

export function buildCustomLaunchArgv(
  executable: string,
  passthrough: readonly string[],
): string[] {
  return [executable, ...passthrough];
}

export const LAUNCHER_FAMILIES = {
  CLAUDEY: 'claudey',
  CLAUDEY_ALL: 'claudey-all',
  CODEXY: 'codexy',
  OPENCODEY: 'opencodey',
  OMPY: 'ompy',
  CLAUDEY_ALL_OMNI: 'claudey-all-omni',
  CODEXY_ALL_OMNI: 'codexy-all-omni',
} as const;
export type LauncherFamily =
  (typeof LAUNCHER_FAMILIES)[keyof typeof LAUNCHER_FAMILIES];

/**
 * Which launcher family serves `harness`/`model`. Exhaustive over
 * `RuntimeHarness`: every member gets an explicit branch below, and the
 * `never`-typed default proves at compile time that adding a future
 * `RuntimeHarness` member without a matching branch here fails to build.
 * A harness value that reaches here outside the known set (e.g. a bad
 * caller-side cast) throws by name instead of silently resolving to
 * `claudey`/`claudey-all` — the defect this function used to have, where
 * any unrecognized harness fell through the if-chain into the Claude branch.
 */
export function launcherFamily(harness: Harness, model: string): LauncherFamily {
  const canonical = resolveModel(harness, model);
  if (harness === HARNESS_NAMES.CLAUDEY_ALL_OMNI) {
    return LAUNCHER_FAMILIES.CLAUDEY_ALL_OMNI;
  }
  if (harness === HARNESS_NAMES.CODEXY_ALL_OMNI) {
    return LAUNCHER_FAMILIES.CODEXY_ALL_OMNI;
  }
  const runtime = harness;
  switch (runtime) {
    case HARNESS_NAMES.CODEX:
      return LAUNCHER_FAMILIES.CODEXY;
    case HARNESS_NAMES.OPENCODE:
      return LAUNCHER_FAMILIES.OPENCODEY;
    case HARNESS_NAMES.OMP:
      return LAUNCHER_FAMILIES.OMPY;
    case HARNESS_NAMES.CLAUDE:
      return isGptModel(canonical)
        ? LAUNCHER_FAMILIES.CLAUDEY_ALL
        : LAUNCHER_FAMILIES.CLAUDEY;
    default: {
      const unrecognized: never = runtime;
      throw new Error(
        `launcherFamily: unrecognized harness "${String(unrecognized)}"`,
      );
    }
  }
}

export function sameLauncherFamily(
  harness: Harness,
  a: string,
  b: string,
): boolean {
  return launcherFamily(harness, a) === launcherFamily(harness, b);
}

function launcherExecutable(family: LauncherFamily): string {
  if (
    family === LAUNCHER_FAMILIES.CLAUDEY_ALL ||
    family === LAUNCHER_FAMILIES.CLAUDEY_ALL_OMNI ||
    family === LAUNCHER_FAMILIES.CODEXY_ALL_OMNI
  ) {
    return family;
  }
  return throneLauncherPath(family);
}

export function buildLaunchArgv(request: HarnessRequest): string[] {
  const model = resolveModel(request.harness, request.model);
  const launcher = launcherExecutable(launcherFamily(request.harness, model));
  const launchModel = isOmniHarness(request.harness)
    ? omniProviderModel(model)
    : model;
  if (launchModel === undefined) {
    throw new Error(`${request.harness}/${model} is outside the Omni manifest`);
  }
  if (runtimeHarness(request.harness) === HARNESS_NAMES.CLAUDE) {
    return [
      launcher,
      '--model',
      launchModel,
      '--effort',
      effortToken(request.harness, request.effort),
    ];
  }
  if (runtimeHarness(request.harness) === HARNESS_NAMES.OPENCODE) {
    return [launcher, '-m', launchModel];
  }
  if (runtimeHarness(request.harness) === HARNESS_NAMES.OMP) {
    // Unlike claudey/codexy, bin/ompy (slice 04) passes args through
    // verbatim with no baked-in yolo flags of its own, so the throne's
    // always-yolo launch posture is emitted here.
    return [
      launcher,
      '--model',
      launchModel,
      '--thinking',
      effortToken(request.harness, request.effort),
      '--auto-approve',
      '--approval-mode',
      'yolo',
    ];
  }
  return [
    launcher,
    '-m',
    launchModel,
    '-c',
    `model_reasoning_effort="${effortToken(request.harness, request.effort)}"`,
  ];
}

export function buildResumeArgv(
  request: HarnessRequest,
  sessionId: string,
): string[] {
  const id = sessionId.trim();
  if (id === '') {
    throw new Error('exact resume requires a native session id');
  }
  const argv = buildLaunchArgv(request);
  const runtime = runtimeHarness(request.harness);
  if (runtime === HARNESS_NAMES.CODEX) {
    return [...argv, 'resume', id];
  }
  if (runtime === HARNESS_NAMES.OPENCODE) {
    return [...argv, '-s', id];
  }
  // claude and omp (confirmed via `omp --help`: `-r, --resume=<value>`) both
  // resume with `--resume <id>`.
  return [...argv, '--resume', id];
}

/** Nest-owned boundary for harness identity, model, and launch translation. */
@Injectable()
export class HarnessService {
  resolveModel(harness: Harness, model: string): string {
    return resolveModel(harness, model);
  }

  buildLaunchArgv(request: HarnessRequest): string[] {
    return buildLaunchArgv(request);
  }

  buildResumeArgv(request: HarnessRequest, sessionId: string): string[] {
    return buildResumeArgv(request, sessionId);
  }

  launcherPath(launcher: ThroneLauncher): string {
    return throneLauncherPath(launcher);
  }
}
