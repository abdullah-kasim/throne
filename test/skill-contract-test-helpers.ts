import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';

// A line only counts as a heading when it is real prose structure. Inside a
// fenced code block `# ...` is a shell comment, and the skills are full of
// them; treating one as an H1 silently truncates the section under audit and
// turns every contract check that reads it into a false failure.
function headingLevelsByLine(lines: string[]): Array<number | undefined> {
  let fence: string | undefined;
  return lines.map((line) => {
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark !== undefined) {
      if (fence === undefined) {
        fence = fenceMark[0];
        return undefined;
      }
      if (fenceMark[0] === fence) fence = undefined;
      return undefined;
    }
    if (fence !== undefined) return undefined;
    return /^#+(?=\s)/.exec(line)?.[0].length;
  });
}

export function readMarkdownSection(source: string, heading: string): string {
  const lines = source.split('\n');
  const levels = headingLevelsByLine(lines);
  const start = lines.findIndex(
    (line, index) => levels[index] !== undefined && line.trim() === heading,
  );
  if (start === -1) return '';
  const headingLevel = /^#+/.exec(heading)?.[0].length;
  if (headingLevel === undefined) return '';
  const endOffset = levels.slice(start + 1).findIndex((nextLevel) => {
    return nextLevel !== undefined && nextLevel <= headingLevel;
  });
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

export function replaceUniqueText(
  source: string,
  before: string,
  after: string,
  label: string,
): string {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${label}: mutation anchor exists`);
  assert.equal(
    source.indexOf(before, first + before.length),
    -1,
    `${label}: mutation anchor is unique`,
  );
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

const CANONICAL_TODO_SKILLS = new Set([
  'write-todos',
  'execute-todos',
  'write-and-execute-todos',
  'gap-analysis-model',
]);

// Skills that live alongside the todo family in .claude/skills but are not
// todo-workflow aliases at all — they carry their own standalone contract and
// must not be graded as a thin write-todos/execute-todos forwarder.
const NON_TODO_SKILLS = new Set(['na', 'no-alpha', 'usage', 'review-loop']);

export function todoAliasSkillNames(skillsDirectory: string): string[] {
  return readdirSync(skillsDirectory)
    .filter(
      (entry) =>
        !CANONICAL_TODO_SKILLS.has(entry) &&
        !NON_TODO_SKILLS.has(entry) &&
        statSync(`${skillsDirectory}/${entry}`).isDirectory(),
    )
    .sort();
}
