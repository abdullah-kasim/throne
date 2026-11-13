import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSpecFixture } from "../../scripts/spec-behaviour-evidence-fixture.mjs";
import { runFeatureMap } from "./feature-map.ts";

export interface SpecFixture {
  readonly scratch: string;
  readonly dataHome: string;
  readonly repositories: Record<string, string>;
  remove(): Promise<void>;
}

export async function runQuietly(commandArguments: readonly string[], registry: readonly string[] = []) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runFeatureMap(commandArguments, {
    throneRegistry: async () => registry,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

export async function makeSpecFixture(): Promise<SpecFixture> {
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "spec-fixture-")));
  const repositories = await buildSpecFixture(scratch, async (folder, repositoryRoot) => {
    await runQuietly([folder, "--repository", repositoryRoot]);
  });
  return {
    scratch,
    dataHome: path.join(scratch, "data-home"),
    repositories,
    remove: () => rm(scratch, { recursive: true, force: true }),
  };
}
