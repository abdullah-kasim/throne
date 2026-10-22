import type { ForgeDependencies, ProcessResult } from "./forge-dependencies.ts";
import type { GithubProgram } from "./pull-request-forge.ts";
import { OPEN_PULL_REQUEST_LIST_FIELDS, PULL_REQUEST_VIEW_FIELDS } from "./pull-request-shapes.ts";

export const GH_GUARD_BYPASS_FLAG = "--bypass";

export interface GithubInvocation {
  readonly program: GithubProgram;
  readonly repo: string;
  readonly bypass: boolean;
  readonly timeoutMilliseconds?: number;
}

export function githubPushArguments(branch: string): string[] {
  return ["push", "-u", "origin", branch];
}

export function githubCreateArguments(request: {
  readonly title: string;
  readonly bodyFile: string;
  readonly base: string;
  readonly head: string;
  readonly draft: boolean;
}): string[] {
  return [
    "pr",
    "create",
    ...(request.draft ? ["--draft"] : []),
    "--base",
    request.base,
    "--head",
    request.head,
    "--title",
    request.title,
    "--body-file",
    request.bodyFile,
  ];
}

export function githubViewArguments(target: string, fields: string = PULL_REQUEST_VIEW_FIELDS): string[] {
  return ["pr", "view", target, "--json", fields];
}

export function githubEditArguments(target: string, change: { readonly title?: string; readonly bodyFile?: string }): string[] {
  return [
    "pr",
    "edit",
    target,
    ...(change.title === undefined ? [] : ["--title", change.title]),
    ...(change.bodyFile === undefined ? [] : ["--body-file", change.bodyFile]),
  ];
}

export function githubReadyArguments(target: string): string[] {
  return ["pr", "ready", target];
}

export function githubListOpenArguments(limit: number): string[] {
  return ["pr", "list", "--state", "open", "--limit", String(limit), "--json", OPEN_PULL_REQUEST_LIST_FIELDS];
}

export function githubDiffArguments(target: string): string[] {
  return ["pr", "diff", target];
}

export function githubSquashMergeArguments(target: string): string[] {
  return ["pr", "merge", target, "--squash", "--delete-branch=false"];
}

export function githubCommentArguments(target: string, bodyFile: string): string[] {
  return ["pr", "comment", target, "--body-file", bodyFile];
}

export function githubRenderMarkdownArguments(text: string): string[] {
  return ["api", "-X", "POST", "/markdown", "-f", "mode=gfm", "-f", `text=${text}`];
}

export function runGithub(
  args: readonly string[],
  invocation: GithubInvocation,
  dependencies: ForgeDependencies,
): Promise<ProcessResult> {
  return dependencies.runProcess(invocation.program, [...(invocation.bypass ? [GH_GUARD_BYPASS_FLAG] : []), ...args], {
    cwd: invocation.repo,
    timeoutMilliseconds: invocation.timeoutMilliseconds,
  });
}
