import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ownedHerdrClientPath, runHerdr } from './herdr-client.ts';

export const HERDR_OPERATOR_SKILL_ROLES: readonly string[] = ['Stager', 'Regent'];
export const HERDR_OPERATOR_SKILL_RELATIVE_PATH = path.join('.claude', 'skills', 'herdr', 'SKILL.md');
export const HERDR_OPERATOR_SKILL_ARGS: readonly string[] = ['--skill'];

export interface HerdrOperatorSkillDependencies {
  readOfficialSkill(): Promise<string>;
  pinnedHerdrPath(): string;
  writeSkillFile(filePath: string, content: string): Promise<void>;
}

export type HerdrOperatorSkillOutcome =
  | { kind: 'installed'; filePath: string }
  | { kind: 'not-an-operator-role'; role: string }
  | { kind: 'failed'; filePath: string; message: string };

export const DEFAULT_HERDR_OPERATOR_SKILL_DEPENDENCIES: HerdrOperatorSkillDependencies = {
  readOfficialSkill: async () => (await runHerdr([...HERDR_OPERATOR_SKILL_ARGS])).stdout,
  pinnedHerdrPath: () => ownedHerdrClientPath(),
  writeSkillFile: async (filePath, content) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  },
};

export function isHerdrOperatorRole(role: string): boolean {
  return HERDR_OPERATOR_SKILL_ROLES.includes(role.trim());
}

export function herdrOperatorSkillPath(cwd: string): string {
  return path.join(cwd, HERDR_OPERATOR_SKILL_RELATIVE_PATH);
}

export function throneHerdrPreamble(pinnedHerdrPath: string): string {
  return [
    '## Throne court rules (read before the official guide below)',
    '',
    'This skill is generated at spawn for the Stager and the Regent only; an Alpha or Shadow never receives it.',
    '',
    `- \`herdr\` in this tab is the throne's \`bin/herdr\` shim, which runs the pinned client at \`${pinnedHerdrPath}\`. Do not call any other herdr binary.`,
    '- Reads and focus are free: `tab list`, `tab focus`, `pane list`, `pane read`, `agent list`, `agent get`, `agent read`, `pane layout`.',
    '- Anything that types into another agent\'s pane goes through `throne send-agent <name> <message>`, never `pane send-text`, `pane run`, `agent prompt`, or `agent send-keys`. The throne serializes delivery per pane and protects a resident human draft; raw pane input bypasses both.',
    '- Never `agent start`, `tab create`, `tab close`, `pane close`, or `pane split` for court agents: `throne create-agent` and `throne reap-agent` own that lifecycle and its ledger.',
    '- Never touch `herdr server` or `herdr session` from a court tab.',
    '',
    'The Lord asking "switch my tab", "what is that pane doing", or "is the Regent stuck" is the intended use.',
    '',
  ].join('\n');
}

export function renderHerdrOperatorSkill(officialSkill: string, pinnedHerdrPath: string): string {
  const frontmatterEnd = officialSkill.indexOf('\n---', 3);
  if (!officialSkill.startsWith('---') || frontmatterEnd === -1) {
    throw new Error('herdr --skill output does not start with a frontmatter block');
  }
  const bodyStart = frontmatterEnd + '\n---'.length;
  const frontmatter = officialSkill.slice(0, bodyStart);
  const body = officialSkill.slice(bodyStart).replace(/^\n+/, '');
  return `${frontmatter}\n\n${throneHerdrPreamble(pinnedHerdrPath)}\n${body}`;
}

export async function installHerdrOperatorSkill(
  role: string,
  cwd: string,
  deps: HerdrOperatorSkillDependencies = DEFAULT_HERDR_OPERATOR_SKILL_DEPENDENCIES,
): Promise<HerdrOperatorSkillOutcome> {
  if (!isHerdrOperatorRole(role)) {
    return { kind: 'not-an-operator-role', role };
  }
  const filePath = herdrOperatorSkillPath(cwd);
  try {
    const official = await deps.readOfficialSkill();
    await deps.writeSkillFile(filePath, renderHerdrOperatorSkill(official, deps.pinnedHerdrPath()));
    return { kind: 'installed', filePath };
  } catch (error) {
    return {
      kind: 'failed',
      filePath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
