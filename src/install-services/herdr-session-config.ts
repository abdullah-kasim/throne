import os from 'node:os';
import path from 'node:path';
import {
  rewriteTextFile,
  type TextFileRewriteOptions,
  type TextFileRewriteOutcome,
} from './text-file-rewrite.ts';

export type HerdrResumeSwitchOutcome = TextFileRewriteOutcome;

const SESSION_TABLE_HEADER = '[session]';
const RESUME_ON_RESTORE_DISABLED = 'resume_agents_on_restore = false';
const RESUME_ON_RESTORE_VALUE = /^(\s*resume_agents_on_restore\s*=\s*)(true|false)\b/;

export function herdrConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  if (env.HERDR_CONFIG_PATH) {
    return env.HERDR_CONFIG_PATH;
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDirectory, '.config');
  return path.join(configHome, 'herdr', 'config.toml');
}

function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

function isSessionTableHeader(line: string): boolean {
  return /^\s*\[\s*session\s*\]\s*(#.*)?$/.test(line);
}

function isResumeOnRestoreSetting(line: string): boolean {
  return RESUME_ON_RESTORE_VALUE.test(line);
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function withSessionTableAppended(tomlText: string): string {
  const sessionTable = `${SESSION_TABLE_HEADER}\n${RESUME_ON_RESTORE_DISABLED}\n`;
  if (tomlText === '') {
    return sessionTable;
  }
  const textEndingInNewline = tomlText.endsWith('\n') ? tomlText : `${tomlText}\n`;
  return `${textEndingInNewline}\n${sessionTable}`;
}

function sessionTableEnd(lines: readonly string[], headerIndex: number): number {
  const nextHeaderOffset = lines.slice(headerIndex + 1).findIndex(isTableHeader);
  return nextHeaderOffset === -1 ? lines.length : headerIndex + 1 + nextHeaderOffset;
}

function lastContentLineIndex(lines: readonly string[], headerIndex: number, tableEnd: number): number {
  let index = tableEnd - 1;
  while (index > headerIndex && isBlank(lines[index] ?? '')) {
    index -= 1;
  }
  return index;
}

export function herdrSessionConfigEdit(tomlText: string): string {
  const lines = tomlText.split('\n');
  const headerIndex = lines.findIndex(isSessionTableHeader);
  if (headerIndex === -1) {
    return withSessionTableAppended(tomlText);
  }
  const tableEnd = sessionTableEnd(lines, headerIndex);
  const settingIndex = lines.findIndex(
    (line, index) => index > headerIndex && index < tableEnd && isResumeOnRestoreSetting(line),
  );
  if (settingIndex === -1) {
    lines.splice(lastContentLineIndex(lines, headerIndex, tableEnd) + 1, 0, RESUME_ON_RESTORE_DISABLED);
  } else {
    lines[settingIndex] = (lines[settingIndex] ?? '').replace(RESUME_ON_RESTORE_VALUE, '$1false');
  }
  return lines.join('\n');
}

export function ensureHerdrResumeDisabled(
  configPath: string,
  options: TextFileRewriteOptions = {},
): Promise<HerdrResumeSwitchOutcome> {
  return rewriteTextFile(configPath, herdrSessionConfigEdit, options);
}
