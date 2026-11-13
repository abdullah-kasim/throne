import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OURS_EMPTY = "ours-empty";
export const NOT_OURS_EMPTY = "not-ours-empty";
export const OURS_WITH_THRONE_SPECS = "ours-with-throne-specs";
export const NOT_OURS_OWN_SPEC_NO_MAP = "not-ours-own-spec-no-map";
export const NOT_OURS_OWN_MAP_NO_SPEC = "not-ours-own-map-no-spec";
export const OURS_WITH_WORKTREE = "ours-with-worktree";
export const LINKED_WORKTREE = "ours-with-worktree-linked";
export const NOT_OURS_REPOSITORIES = [NOT_OURS_EMPTY, NOT_OURS_OWN_SPEC_NO_MAP, NOT_OURS_OWN_MAP_NO_SPEC];

export function specFileText({ name, summary, code, searchWords = name, subFeatures = [], extraLines = 0, skipSection }) {
  const sections = {
    "## What it does": [`${name} does one thing.`],
    "## Sub-features": subFeatures.map((id) => `- ${id}: a part of ${name}.`),
    "## How to reach it and prove it works": ["Run it and read the output."],
    "## Gotchas": ["None known.", ...Array.from({ length: extraLines }, (_, index) => `Filler line ${index + 1}.`)],
  };
  const body = Object.entries(sections)
    .filter(([title]) => title !== skipSection)
    .flatMap(([title, lines]) => ["", title, "", ...lines]);
  return [`# ${name}`, `Summary: ${summary}`, `Code: ${code.join(", ")}`, `Search words: ${searchWords}`, ...body].join("\n") + "\n";
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function git(directory, ...gitArguments) {
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...gitArguments], {
    cwd: directory,
    stdio: "ignore",
  });
}

function repositoryWith(root, name, files) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  write(path.join(directory, "README.md"), `# ${name}\n`);
  for (const [relativePath, text] of Object.entries(files)) write(path.join(directory, relativePath), text);
  git(directory, "add", "--all");
  git(directory, "commit", "--quiet", "--message", "Start the fixture");
  return directory;
}

export async function buildSpecFixture(scratch, writeFeatureMap) {
  const root = path.join(scratch, "repositories");
  const repositories = {
    [OURS_EMPTY]: repositoryWith(root, OURS_EMPTY, {}),
    [NOT_OURS_EMPTY]: repositoryWith(root, NOT_OURS_EMPTY, {}),
    [NOT_OURS_OWN_SPEC_NO_MAP]: repositoryWith(root, NOT_OURS_OWN_SPEC_NO_MAP, {
      "docs/specs/billing.md": "Billing\n=======\n\nTheir own spec, in their own form.\n",
    }),
    [NOT_OURS_OWN_MAP_NO_SPEC]: repositoryWith(root, NOT_OURS_OWN_MAP_NO_SPEC, {
      "FEATURE_MAP.md": "Our features\n\n* billing\n* reports\n",
    }),
    [OURS_WITH_WORKTREE]: repositoryWith(root, OURS_WITH_WORKTREE, {}),
  };
  const throneSpecs = path.join(root, OURS_WITH_THRONE_SPECS, "specs");
  repositories[OURS_WITH_THRONE_SPECS] = path.join(root, OURS_WITH_THRONE_SPECS);
  write(path.join(repositories[OURS_WITH_THRONE_SPECS], "src/greeter.ts"), "export const greeting = 1;\n");
  write(path.join(throneSpecs, "greeting/greeter.md"), specFileText({ name: "Greeter", summary: "Says hello.", code: ["src/greeter.ts"], subFeatures: ["GR1"] }));
  await writeFeatureMap(throneSpecs, repositories[OURS_WITH_THRONE_SPECS]);
  repositoryWith(root, OURS_WITH_THRONE_SPECS, {});
  const linked = path.join(root, LINKED_WORKTREE);
  git(repositories[OURS_WITH_WORKTREE], "worktree", "add", "--quiet", "-b", "linked", linked);
  repositories[LINKED_WORKTREE] = linked;
  return repositories;
}
