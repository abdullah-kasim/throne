// Where an agent's durable, cross-session memory lives for the project it is
// working in. The throne never invents a second convention when one is
// already in force: a target repo's own in-tree memory tree wins, then a
// memory directive in the project's instruction files, then a `memory-dir`
// executable on PATH (the operator's personal tooling), and only when none
// of those exist does the throne fall back to its own machine-local root.
//
// Every mode keys on the REPOSITORY, not the checkout path: a linked git
// worktree and any subdirectory resolve to the main checkout, so every
// worktree of one project shares one memory directory. That is what lets a
// Shadow's learning reach its siblings the moment it is written, without a
// merge and without anything to lose on reap.
import path from 'node:path';

export type MemoryMode =
  | 'in-tree'
  | 'project-declared'
  | 'external'
  | 'throne-native';

export interface MemoryResolution {
  mode: MemoryMode;
  /** Absolute directory the agent reads and writes. Always present. */
  path: string;
  /** The identity every mode keys on: the main checkout, or DIR itself when
   *  DIR is not inside a git repository. */
  repoRoot: string;
  /** What decided the mode: a directory, a `file:line`, or an executable. */
  evidence: string;
  /** Set when a project declared a memory convention this resolver could
   *  not follow, so the agent must read the cited file itself. */
  warning?: string;
}

export interface MemoryResolverDeps {
  /** `git rev-parse --git-common-dir` from `dir`; undefined outside a repo
   *  or when git is unavailable. May be relative to `dir`. */
  gitCommonDir(dir: string): Promise<string | undefined>;
  pathExists(candidate: string): Promise<boolean>;
  /** File contents, or undefined when it does not exist. */
  readText(file: string): Promise<string | undefined>;
  /** PATH lookup: the absolute executable, or undefined. */
  findExecutable(name: string): Promise<string | undefined>;
  /** Runs `executable args...` in `cwd`; resolves to trimmed stdout. */
  runExecutable(executable: string, args: string[], cwd: string): Promise<string>;
  /** Symlink-resolved absolute path (`pwd -P` semantics). */
  realpath(candidate: string): Promise<string>;
  homeDir(): string;
}

/** A target repo's own in-tree memory tree. The throne itself no longer has
 *  one; this exists for repos that keep memory committed. */
export const IN_TREE_MEMORY_PATH = 'agent_docs/MEMORY';

/** Project instruction files inspected, root-level only, in this order. */
export const PROJECT_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
] as const;

/** Strict tokens that mark a memory directive. Prose about "memory usage"
 *  must never hijack the resolution, so the bare word is deliberately absent. */
export const PROJECT_MEMORY_DIRECTIVE_TOKENS = [
  'memory-dir',
  '~/.memories',
  '.memories/',
  IN_TREE_MEMORY_PATH,
] as const;

/** The operator's personal memory tool, when the machine has one. */
export const EXTERNAL_MEMORY_EXECUTABLE = 'memory-dir';

/** Throne-owned, machine-local fallback root — throne state, so it lives
 *  under `~/.throne/` like worktrees and locks, never under the operator's
 *  personal `~/.memories/`. */
export const THRONE_MEMORIES_DIRNAME = path.join('.throne', 'memories');

/** Every `/` becomes `-`, the leading one included, so
 *  `/home/x/repos/app` -> `-home-x-repos-app`. */
export function memorySlug(repoRoot: string): string {
  return repoRoot.replaceAll('/', '-');
}

export function throneNativeMemoryDir(homeDir: string, repoRoot: string): string {
  return path.join(homeDir, THRONE_MEMORIES_DIRNAME, memorySlug(repoRoot));
}

async function resolveRepoRoot(
  dir: string,
  deps: MemoryResolverDeps,
): Promise<{ root: string; physicalDir: string }> {
  const physicalDir = await deps.realpath(dir);
  const common = await deps.gitCommonDir(physicalDir);
  if (common === undefined || common === '') {
    return { root: physicalDir, physicalDir };
  }
  const absoluteCommon = await deps.realpath(
    path.isAbsolute(common) ? common : path.join(physicalDir, common),
  );
  // `<checkout>/.git` for a plain repo AND every linked worktree; anything
  // else is a bare repository whose directory is the identity itself.
  const root =
    path.basename(absoluteCommon) === '.git'
      ? path.dirname(absoluteCommon)
      : absoluteCommon;
  return { root, physicalDir };
}

interface ProjectDirective {
  file: string;
  line: number;
  token: string;
}

async function findProjectDirective(
  repoRoot: string,
  deps: MemoryResolverDeps,
): Promise<ProjectDirective | undefined> {
  for (const basename of PROJECT_INSTRUCTION_FILES) {
    const file = path.join(repoRoot, basename);
    const text = await deps.readText(file);
    if (text === undefined) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      const token = PROJECT_MEMORY_DIRECTIVE_TOKENS.find((candidate) =>
        line.includes(candidate),
      );
      if (token !== undefined) {
        return { file, line: index + 1, token };
      }
    }
  }
  return undefined;
}

async function runExternalTool(
  executable: string,
  physicalDir: string,
  deps: MemoryResolverDeps,
): Promise<string> {
  const output = await deps.runExecutable(executable, [physicalDir], physicalDir);
  const resolved = output.trim().split('\n')[0] ?? '';
  if (resolved === '' || !path.isAbsolute(resolved)) {
    throw new Error(
      `${executable} printed "${resolved}" instead of an absolute directory`,
    );
  }
  return resolved;
}

export async function resolveMemoryDir(
  dir: string,
  deps: MemoryResolverDeps,
): Promise<MemoryResolution> {
  const { root, physicalDir } = await resolveRepoRoot(dir, deps);
  const inTree = path.join(root, IN_TREE_MEMORY_PATH);
  if (await deps.pathExists(inTree)) {
    return { mode: 'in-tree', path: inTree, repoRoot: root, evidence: inTree };
  }

  const directive = await findProjectDirective(root, deps);
  const external = await deps.findExecutable(EXTERNAL_MEMORY_EXECUTABLE);
  const nativeDir = throneNativeMemoryDir(deps.homeDir(), root);

  if (directive !== undefined) {
    const evidence = `${directive.file}:${directive.line}`;
    if (external !== undefined) {
      return {
        mode: 'project-declared',
        path: await runExternalTool(external, physicalDir, deps),
        repoRoot: root,
        evidence: `${evidence} (via ${external})`,
      };
    }
    return {
      mode: 'project-declared',
      path: nativeDir,
      repoRoot: root,
      evidence,
      warning:
        `${evidence} declares a memory convention ("${directive.token}") but no ` +
        `\`${EXTERNAL_MEMORY_EXECUTABLE}\` executable is on PATH to honour it; ` +
        `read that file and follow it — ${nativeDir} is only the fallback.`,
    };
  }

  if (external !== undefined) {
    return {
      mode: 'external',
      path: await runExternalTool(external, physicalDir, deps),
      repoRoot: root,
      evidence: external,
    };
  }

  return {
    mode: 'throne-native',
    path: nativeDir,
    repoRoot: root,
    evidence: `no in-tree ${IN_TREE_MEMORY_PATH}, no project directive, no ${EXTERNAL_MEMORY_EXECUTABLE} on PATH`,
  };
}

/** The one paragraph every spawned agent carries about its memory, rendered
 *  from a resolution taken at spawn time so the ledger records what was true
 *  then; the agent re-resolves with the command when it moves. */
export function formatMemoryStandingInstruction(
  resolution: MemoryResolution | undefined,
): string {
  const command = '`throne memory-dir --json`';
  if (resolution === undefined) {
    return (
      `Your durable cross-session memory directory was not resolved at spawn: ` +
      `run ${command} from your cwd before acting, \`ls\` the directory it names ` +
      `and read anything relevant, and write every correction, busted ` +
      `assumption, or dead end there the moment it happens.`
    );
  }
  const modeNote: Record<MemoryMode, string> = {
    'in-tree': 'this project keeps memory committed in its own tree, so commit what you write there',
    'project-declared': 'this project declares its own memory convention, which outranks the throne\'s',
    external: 'this machine\'s own memory tooling resolved it, and the throne defers to it',
    'throne-native': 'no project or machine convention exists, so the throne\'s own root is used',
  };
  const warning =
    resolution.warning === undefined ? '' : ` WARNING: ${resolution.warning}`;
  return (
    `Your durable cross-session memory directory is \`${resolution.path}\` ` +
    `(mode ${resolution.mode}: ${modeNote[resolution.mode]}; evidence ` +
    `${resolution.evidence}).${warning} \`ls\` it and read anything relevant ` +
    `before acting; write every correction, busted assumption, or dead end ` +
    `there the moment it happens, one SCREAMING_SNAKE_CASE.md file per lesson. ` +
    `It is shared by every worktree of this project, so nothing needs merging ` +
    `and nothing is lost on reap. Re-resolve with ${command} if you change ` +
    `project.`
  );
}
