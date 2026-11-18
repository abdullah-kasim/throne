import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { specFileText } from "../../scripts/spec-behaviour-evidence-fixture.mjs";
import { memorySlug } from "../memory-dir/memory-dir-resolver.ts";
import { THRONE_HOME_ENV } from "../shared-policy/throne-home.ts";

export const REAL_SPEC_ID = "GREET-HELLO";
export const LAUNCH_READY_BODY = [
  "INTENT: greet people more warmly.",
  "SCOPE: the greeter only.",
  "RULINGS: none.",
  "VERIFIED-NOUNS: src/greeter.ts.",
].join("\n");

export interface SpecCitationFixture {
  readonly scratch: string;
  readonly specRepository: string;
  readonly brokenSpecRepository: string;
  readonly plainRepository: string;
  remove(): Promise<void>;
}

async function repositoryWith(root: string, name: string, files: Record<string, string>): Promise<string> {
  const directory = path.join(root, name);
  for (const [relativePath, text] of Object.entries({ "README.md": `# ${name}\n`, ...files })) {
    await mkdir(path.dirname(path.join(directory, relativePath)), { recursive: true });
    await writeFile(path.join(directory, relativePath), text);
  }
  await promisify(execFile)("git", ["init", "--quiet", "--initial-branch=main"], { cwd: directory });
  return directory;
}

export async function makeSpecCitationFixture(): Promise<SpecCitationFixture> {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "spec-citation-")));
  const dataHome = path.join(scratch, "data-home");
  const greeterSpec = {
    "specs/greeting/greeter.md": specFileText({ name: "Greeter", summary: "Says hello.", code: ["src/greeter.ts"], subFeatures: [REAL_SPEC_ID] }),
  };
  const specRepository = await repositoryWith(scratch, "with-spec", greeterSpec);
  const brokenSpecRepository = await repositoryWith(scratch, "broken-spec", greeterSpec);
  const plainRepository = await repositoryWith(scratch, "without-spec", {});
  const brokenSettings = path.join(dataHome, "specs", memorySlug(await realpath(os.homedir()), brokenSpecRepository), "settings.json");
  await mkdir(path.dirname(brokenSettings), { recursive: true });
  await writeFile(brokenSettings, "{ not json");
  const previousDataHome = process.env[THRONE_HOME_ENV];
  process.env[THRONE_HOME_ENV] = dataHome;
  return {
    scratch,
    specRepository,
    brokenSpecRepository,
    plainRepository,
    remove: async () => {
      if (previousDataHome === undefined) delete process.env[THRONE_HOME_ENV];
      else process.env[THRONE_HOME_ENV] = previousDataHome;
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
