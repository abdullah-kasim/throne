import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'bun:test';
import { load } from 'js-yaml';

const skillsFolder = resolve(import.meta.dir, '..', '.claude', 'skills');
const longestDescription = 1024;

async function skillFileFaults(skillFile: string): Promise<string[]> {
  const text = await readFile(skillFile, 'utf8').catch(() => undefined);
  if (text === undefined) return [];
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!frontmatter) return [`${skillFile}: no frontmatter`];
  let fields: unknown;
  try {
    fields = load(frontmatter[1]);
  } catch (error) {
    return [`${skillFile}: frontmatter is not valid YAML: ${(error as Error).message.split('\n')[0]}`];
  }
  const description = (fields as { description?: unknown } | null)?.description;
  if (typeof description !== 'string' || description.length === 0) return [`${skillFile}: no description`];
  if (description.length > longestDescription) {
    return [`${skillFile}: description is ${description.length} characters, over ${longestDescription}`];
  }
  return [];
}

test('every skill frontmatter parses as strict YAML with a description of at most 1024 characters', async () => {
  const entries = await readdir(skillsFolder, { withFileTypes: true });
  const skillFiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(skillsFolder, entry.name, 'SKILL.md'));
  assert.ok(skillFiles.length > 0);
  const faults = await Promise.all(skillFiles.map(skillFileFaults));
  assert.deepEqual(faults.flat(), []);
});
