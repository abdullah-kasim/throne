import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandStatus extends CommandResult {
  code: number;
}

export type GitExecutor = (
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

export type GitStatusReader = (
  args: string[],
  cwd: string,
) => Promise<CommandStatus>;

function executeGit(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function readGitStatusResult(
  args: string[],
  cwd: string,
): Promise<CommandStatus> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const rawCode = error && 'code' in error ? error.code : 1;
        resolve({
          code: error === null ? 0 : typeof rawCode === 'number' ? rawCode : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

@Injectable()
export class GitLifecycleService {
  private readonly execute: GitExecutor;
  private readonly readStatus: GitStatusReader;

  constructor(
    execute: GitExecutor = executeGit,
    readStatus: GitStatusReader = readGitStatusResult,
  ) {
    this.execute = execute;
    this.readStatus = readStatus;
  }

  run(args: string[], cwd: string): Promise<CommandResult> {
    return this.execute(args, cwd);
  }

  status(args: string[], cwd: string): Promise<CommandStatus> {
    return this.readStatus(args, cwd);
  }
}

const gitLifecycle = new GitLifecycleService();

export function runCommand(
  file: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`${file} ${args.join(' ')} failed: ${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await gitLifecycle.run(args, cwd);
  return stdout.trim();
}

export function readGitStatus(
  args: string[],
  cwd: string,
): Promise<CommandStatus> {
  return gitLifecycle.status(args, cwd);
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function canonicalPath(candidate: string): Promise<string> {
  return realpath(candidate).catch(() => path.resolve(candidate));
}

export function repoRoot(projectDir: string): Promise<string> {
  return runGit(['rev-parse', '--show-toplevel'], projectDir);
}

export function currentBranch(projectDir: string): Promise<string> {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
}

export function currentCommit(projectDir: string): Promise<string> {
  return runGit(['rev-parse', 'HEAD'], projectDir);
}
