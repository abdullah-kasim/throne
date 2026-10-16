import { readFile } from "node:fs/promises";

export function fileIsMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function readTextFileIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (fileIsMissing(error)) return undefined;
    throw error;
  }
}
