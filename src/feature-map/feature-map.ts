import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CODE_LABEL,
  FEATURE_MAP_FILE_NAME,
  FEATURE_MAP_FIRST_LINES,
  FILES_THAT_ARE_NOT_SPECS,
  FIXED_SECTIONS,
  GENERAL_AREA,
  looksLikeThroneSpecFile,
  NAME_PREFIX,
  SEARCH_WORDS_LABEL,
  SPEC_FILE_LINE_LIMIT,
  SUB_FEATURES_SECTION,
  SUMMARY_LABEL,
} from "./spec-form.ts";

const SUCCESS = 0;
const FAILED = 1;
const REFUSED = 2;
const SUB_FEATURE_LINE = /^- ([A-Za-z0-9][\w.-]*):/;

export interface SpecFile {
  readonly relativePath: string;
  readonly area: string;
  readonly hasHeader: boolean;
  readonly name: string;
  readonly summary: string;
  readonly codePaths: readonly string[];
  readonly searchWords: readonly string[];
  readonly subFeatureIds: readonly string[];
  readonly lineCount: number;
  readonly missingSections: readonly string[];
}

export interface Finding {
  readonly fatal: boolean;
  readonly message: string;
}

export interface SpecSetOptions {
  readonly repositoryRoot: string;
  readonly registry?: readonly string[];
}

function listOf(line: string, label: string): string[] {
  return line
    .slice(label.length)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function subFeatureIdsIn(lines: readonly string[]): string[] {
  const start = lines.indexOf(SUB_FEATURES_SECTION);
  if (start === -1) return [];
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = SUB_FEATURE_LINE.exec(line);
    if (match !== null) ids.push(match[1] as string);
  }
  return ids;
}

export function parseSpecFile(relativePath: string, content: string): SpecFile {
  const lines = content.split("\n");
  const hasHeader = looksLikeThroneSpecFile(content);
  const [nameLine = "", summaryLine = "", codeLine = "", searchWordsLine = ""] = lines;
  const segments = relativePath.split("/");
  return {
    relativePath,
    area: segments.length > 1 ? (segments[0] as string) : GENERAL_AREA,
    hasHeader,
    name: hasHeader ? nameLine.slice(NAME_PREFIX.length).trim() : "",
    summary: hasHeader ? summaryLine.slice(SUMMARY_LABEL.length).trim() : "",
    codePaths: hasHeader ? listOf(codeLine, CODE_LABEL) : [],
    searchWords: hasHeader ? listOf(searchWordsLine, SEARCH_WORDS_LABEL) : [],
    subFeatureIds: subFeatureIdsIn(lines),
    lineCount: content.endsWith("\n") ? lines.length - 1 : lines.length,
    missingSections: FIXED_SECTIONS.filter((section) => !lines.includes(section)),
  };
}

async function markdownFilesUnder(folder: string, relativeFolder: string): Promise<string[]> {
  const entries = await readdir(path.join(folder, relativeFolder), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeFolder === "" ? entry.name : `${relativeFolder}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await markdownFilesUnder(folder, relativePath)));
    else if (entry.name.endsWith(".md")) found.push(relativePath);
  }
  return found;
}

export async function readSpecFolder(specFolder: string): Promise<SpecFile[]> {
  const relativePaths = (await markdownFilesUnder(specFolder, ""))
    .filter((relativePath) => !FILES_THAT_ARE_NOT_SPECS.includes(relativePath))
    .sort();
  return Promise.all(
    relativePaths.map(async (relativePath) =>
      parseSpecFile(relativePath, await readFile(path.join(specFolder, relativePath), "utf8")),
    ),
  );
}

export function buildFeatureMap(specs: readonly SpecFile[]): string {
  const areas = [...new Set(specs.map((spec) => spec.area))].sort();
  const lines = [
    ...FEATURE_MAP_FIRST_LINES,
    `Covered areas: ${areas.length === 0 ? "none" : areas.join(", ")}.`,
    "Everything else is uncatalogued: search the code for it.",
  ];
  for (const area of areas) {
    lines.push("", `## ${area}`, "");
    for (const spec of specs.filter((candidate) => candidate.area === area)) {
      lines.push(`- **${spec.name}**: ${spec.summary} ([${spec.relativePath}](${spec.relativePath}))`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function duplicatesOf(specs: readonly SpecFile[], keysOf: (spec: SpecFile) => readonly string[]): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const spec of specs) {
    for (const key of new Set(keysOf(spec))) owners.set(key, [...(owners.get(key) ?? []), spec.relativePath]);
  }
  return new Map([...owners].filter(([, files]) => files.length > 1));
}

function pathsOverlap(first: string, second: string): boolean {
  const left = path.posix.normalize(first).replace(/\/$/, "");
  const right = path.posix.normalize(second).replace(/\/$/, "");
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function checkSpecSet(specs: readonly SpecFile[], options: SpecSetOptions): Promise<Finding[]> {
  const findings: Finding[] = [];
  const withHeader = specs.filter((spec) => spec.hasHeader);
  for (const spec of specs) {
    if (!spec.hasHeader) {
      findings.push({ fatal: true, message: `${spec.relativePath} lacks the header lines (name, summary, code, search words)` });
    }
    for (const section of spec.missingSections) {
      findings.push({ fatal: true, message: `${spec.relativePath} is missing the section "${section}"` });
    }
    if (spec.lineCount > SPEC_FILE_LINE_LIMIT) {
      findings.push({
        fatal: true,
        message: `${spec.relativePath} is ${spec.lineCount} lines, over the limit of ${SPEC_FILE_LINE_LIMIT}; split it into smaller features`,
      });
    }
    for (const codePath of spec.codePaths) {
      if (!(await pathExists(path.join(options.repositoryRoot, codePath)))) {
        findings.push({ fatal: true, message: `${spec.relativePath} names the path ${codePath}, which does not exist` });
      }
    }
  }
  for (const [name, files] of duplicatesOf(withHeader, (spec) => [spec.name])) {
    findings.push({ fatal: true, message: `the feature name "${name}" is claimed by ${files.join(" and ")}` });
  }
  for (const [id, files] of duplicatesOf(specs, (spec) => spec.subFeatureIds)) {
    findings.push({ fatal: true, message: `the sub-feature ID ${id} is declared by ${files.join(" and ")}` });
  }
  for (const [index, first] of withHeader.entries()) {
    for (const second of withHeader.slice(index + 1)) {
      for (const firstPath of first.codePaths) {
        const overlapping = second.codePaths.find((secondPath) => pathsOverlap(firstPath, secondPath));
        if (overlapping !== undefined) {
          findings.push({
            fatal: false,
            message: `${first.relativePath} and ${second.relativePath} both claim the code path ${firstPath === overlapping ? firstPath : `${firstPath} / ${overlapping}`}`,
          });
        }
      }
    }
  }
  const claimed = new Set(withHeader.flatMap((spec) => spec.searchWords));
  for (const entry of options.registry ?? []) {
    if (!claimed.has(entry)) findings.push({ fatal: false, message: `the registry entry ${entry} is claimed by no spec file` });
  }
  return findings;
}

export interface FeatureMapDependencies {
  throneRegistry(): Promise<readonly string[]>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export const USAGE =
  "Usage: throne feature-map <spec folder> [--check] [--registry throne] [--repository <path>]\n" +
  "Builds FEATURE_MAP.md in the spec folder from the spec files' headers and runs the set checks.\n" +
  "--check writes nothing and exits 1 when the map on disk differs from what would be built.\n" +
  "--registry throne reports every throne command no spec file claims in its search words.\n" +
  "--repository is the root the headers' code paths are relative to; the spec folder's parent by default.\n" +
  "A fatal finding exits 1 and writes nothing; a reported finding is printed and does not change the exit.\n";

interface FeatureMapRequest {
  readonly specFolder: string;
  readonly check: boolean;
  readonly throneRegistry: boolean;
  readonly repositoryRoot: string;
}

function parseFeatureMapRequest(commandArguments: readonly string[]): FeatureMapRequest {
  let specFolder: string | undefined;
  let repositoryRoot: string | undefined;
  let check = false;
  let throneRegistry = false;
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] as string;
    if (argument === "--check") check = true;
    else if (argument === "--registry") {
      if (commandArguments[index + 1] !== "throne") throw new Error("--registry takes the value throne");
      throneRegistry = true;
      index += 1;
    } else if (argument === "--repository") {
      repositoryRoot = commandArguments[index + 1];
      if (repositoryRoot === undefined) throw new Error("--repository needs a path");
      index += 1;
    } else if (argument.startsWith("-")) throw new Error(`unknown flag "${argument}"`);
    else if (specFolder === undefined) specFolder = argument;
    else throw new Error(`unexpected argument "${argument}"`);
  }
  if (specFolder === undefined) throw new Error("name the spec folder");
  const absoluteFolder = path.resolve(specFolder);
  return {
    specFolder: absoluteFolder,
    check,
    throneRegistry,
    repositoryRoot: path.resolve(repositoryRoot ?? path.dirname(absoluteFolder)),
  };
}

export async function runFeatureMap(
  commandArguments: readonly string[],
  dependencies: FeatureMapDependencies,
): Promise<number> {
  let request: FeatureMapRequest;
  try {
    request = parseFeatureMapRequest(commandArguments);
  } catch (error) {
    dependencies.writeStderr(`${USAGE}feature-map refused: ${error instanceof Error ? error.message : String(error)}\n`);
    return REFUSED;
  }
  const specs = await readSpecFolder(request.specFolder);
  const registry = request.throneRegistry ? await dependencies.throneRegistry() : [];
  const findings = await checkSpecSet(specs, { repositoryRoot: request.repositoryRoot, registry });
  for (const finding of findings) {
    dependencies.writeStderr(`${finding.fatal ? "fatal" : "reported"}: ${finding.message}\n`);
  }
  if (findings.some((finding) => finding.fatal)) return FAILED;
  const mapPath = path.join(request.specFolder, FEATURE_MAP_FILE_NAME);
  const mapText = buildFeatureMap(specs);
  if (request.check) {
    const onDisk = await readFile(mapPath, "utf8").catch(() => undefined);
    if (onDisk !== mapText) {
      dependencies.writeStderr(`${mapPath} is out of date; run throne feature-map ${request.specFolder}\n`);
      return FAILED;
    }
    dependencies.writeStdout(`${mapPath} is current: ${specs.length} features\n`);
    return SUCCESS;
  }
  await writeFile(mapPath, mapText);
  dependencies.writeStdout(`wrote ${mapPath}: ${specs.length} features\n`);
  return SUCCESS;
}
