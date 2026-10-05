import { ASK_LINT_RULES_IN_ORDER, askViolationsOf, type AskLintRule } from './ask-lint-rules.ts';
import {
  isSuperseded,
  physicalPath,
  projectMemoryDirectoriesUnder,
  readMemoriesIn,
  readRepositoryFile,
} from './memory-files.ts';
import type { Memory } from './memory-frontmatter.types.ts';
import { repositoryNameOfMemoryDirectory } from './memory-directory-repository.ts';

export interface LintedMemoryDirectory {
  readonly path: string;
  readonly repositoryName: string | undefined;
}

export interface AskViolation {
  readonly filePath: string;
  readonly rule: AskLintRule;
  readonly ask: string | undefined;
}

export interface AskLintResult {
  readonly violations: readonly AskViolation[];
  readonly memoriesFlagged: number;
  readonly memoriesRead: number;
  readonly directoriesRead: number;
}

const NO_ASK_PLACEHOLDER = '(no ask)';

async function eachDirectoryOnce(
  directories: readonly LintedMemoryDirectory[],
): Promise<readonly LintedMemoryDirectory[]> {
  const byPhysicalPath = new Map<string, LintedMemoryDirectory>();
  for (const directory of directories) {
    const physicalDirectory = await physicalPath(directory.path);
    if (!byPhysicalPath.has(physicalDirectory)) byPhysicalPath.set(physicalDirectory, directory);
  }
  return [...byPhysicalPath.values()];
}

function violationsOfMemory(memory: Memory, repositoryName: string | undefined): readonly AskViolation[] {
  return askViolationsOf(memory.frontmatter.ask, repositoryName).map((rule) => ({
    filePath: memory.filePath,
    rule,
    ask: memory.frontmatter.ask,
  }));
}

function inPathThenRuleOrder(left: AskViolation, right: AskViolation): number {
  if (left.filePath !== right.filePath) return left.filePath < right.filePath ? -1 : 1;
  return ASK_LINT_RULES_IN_ORDER.indexOf(left.rule) - ASK_LINT_RULES_IN_ORDER.indexOf(right.rule);
}

export async function lintAsks(directories: readonly LintedMemoryDirectory[]): Promise<AskLintResult> {
  const lintedDirectories = await eachDirectoryOnce(directories);
  const violations: AskViolation[] = [];
  let memoriesRead = 0;
  for (const directory of lintedDirectories) {
    const memories = (await readMemoriesIn(directory.path)).filter((memory) => !isSuperseded(memory));
    const repositoryFile = await readRepositoryFile(directory.path);
    memoriesRead += memories.length + (repositoryFile === undefined ? 0 : 1);
    violations.push(...memories.flatMap((memory) => violationsOfMemory(memory, directory.repositoryName)));
    if (repositoryFile !== undefined) violations.push(...violationsOfMemory(repositoryFile, undefined));
  }
  return {
    violations: violations.sort(inPathThenRuleOrder),
    memoriesFlagged: new Set(violations.map((violation) => violation.filePath)).size,
    memoriesRead,
    directoriesRead: lintedDirectories.length,
  };
}

export async function projectMemoryDirectoriesToLint(
  homeDirectory: string,
): Promise<readonly LintedMemoryDirectory[]> {
  return Promise.all(
    (await projectMemoryDirectoriesUnder(homeDirectory)).map(async (directory) => ({
      path: directory,
      repositoryName: await repositoryNameOfMemoryDirectory(directory, homeDirectory),
    })),
  );
}

export function renderedAskViolation(violation: AskViolation): string {
  return `${violation.filePath}\t${violation.rule}\t${violation.ask ?? NO_ASK_PLACEHOLDER}\n`;
}

export function renderedAskLintSummary(result: AskLintResult): string {
  return (
    `recall --lint-asks: ${result.violations.length} violations; ` +
    `${result.memoriesFlagged} of ${result.memoriesRead} memories flagged; ` +
    `${result.directoriesRead} memory directories read\n`
  );
}
