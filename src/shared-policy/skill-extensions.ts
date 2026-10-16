import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveThroneHome } from "./throne-home.ts";

const SKILL_EXTENSIONS_FOLDER_NAME = "skill-extensions";
const SKILL_EXTENSION_FILE_SUFFIX = ".md";
const NAMES_THAT_LEAVE_THE_FOLDER: readonly string[] = ["", ".", ".."];
const PATH_SEPARATORS: readonly string[] = ["/", "\\"];

export interface SkillExtensionEntry {
  readonly skillName: string;
  readonly path: string;
}

export interface SkillExtension extends SkillExtensionEntry {
  readonly content: string;
}

export function skillExtensionsDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveThroneHome(environment), SKILL_EXTENSIONS_FOLDER_NAME);
}

export function isPlainSkillName(skillName: string): boolean {
  return (
    !NAMES_THAT_LEAVE_THE_FOLDER.includes(skillName) &&
    !PATH_SEPARATORS.some((separator) => skillName.includes(separator))
  );
}

function skillExtensionPath(skillName: string, environment: NodeJS.ProcessEnv): string {
  return path.join(
    skillExtensionsDirectory(environment),
    `${skillName}${SKILL_EXTENSION_FILE_SUFFIX}`,
  );
}

function fileIsMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readFileUnlessMissing(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (fileIsMissing(error)) return undefined;
    throw error;
  }
}

export async function findSkillExtension(
  skillName: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SkillExtension | undefined> {
  if (!isPlainSkillName(skillName)) return undefined;
  const extensionPath = skillExtensionPath(skillName, environment);
  const content = await readFileUnlessMissing(extensionPath);
  return content === undefined ? undefined : { skillName, path: extensionPath, content };
}

async function fileNamesInFolder(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (fileIsMissing(error)) return [];
    throw error;
  }
}

export async function listSkillExtensions(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SkillExtensionEntry[]> {
  const folder = skillExtensionsDirectory(environment);
  const fileNames = await fileNamesInFolder(folder);
  return fileNames
    .filter((fileName) => fileName.endsWith(SKILL_EXTENSION_FILE_SUFFIX))
    .map((fileName) => ({
      skillName: fileName.slice(0, -SKILL_EXTENSION_FILE_SUFFIX.length),
      path: path.join(folder, fileName),
    }))
    .sort((left, right) => left.skillName.localeCompare(right.skillName));
}
