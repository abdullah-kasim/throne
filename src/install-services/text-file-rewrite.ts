import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type TextFileRewriteOutcome = 'changed' | 'unchanged';

export interface TextFileRewriteOptions {
  dryRun?: boolean;
}

async function readTextFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export async function rewriteTextFile(
  filePath: string,
  edit: (currentText: string) => string,
  { dryRun = false }: TextFileRewriteOptions = {},
): Promise<TextFileRewriteOutcome> {
  const currentText = await readTextFileOrEmpty(filePath);
  const editedText = edit(currentText);
  if (editedText === currentText) {
    return 'unchanged';
  }
  if (!dryRun) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, editedText);
  }
  return 'changed';
}
