import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const BOT_MODEL = 'claude/fable' as const;

export interface BotConfig {
  name: string;
  displayName: string;
  roomTitle: string;
  persona: string;
  skills: string[];
  model: typeof BOT_MODEL;
  personaText: string;
}

const DEFAULT_PERSONA_RELATIVE_PATH = 'persona.md';

async function readBotManifest(botDir: string): Promise<unknown> {
  const manifestPath = join(botDir, 'bot.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`bot folder "${botDir}" has no readable bot.json`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`bot.json in "${botDir}" is not valid JSON`);
  }
}

function requireStringField(
  manifest: Record<string, unknown>,
  field: string,
  botDir: string,
): string {
  const value = manifest[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`bot.json in "${botDir}" is missing required field "${field}"`);
  }
  return value;
}

function requireSkillsField(
  manifest: Record<string, unknown>,
  botDir: string,
): string[] {
  const value = manifest.skills;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((skill) => typeof skill === 'string' && skill.trim() !== '')
  ) {
    throw new Error(
      `bot.json in "${botDir}" is missing required field "skills" (non-empty string array)`,
    );
  }
  return value;
}

function requireBotModel(manifest: Record<string, unknown>, botDir: string): typeof BOT_MODEL {
  const value = manifest.model;
  if (value !== BOT_MODEL) {
    throw new Error(
      `bot.json in "${botDir}" carries model "${String(value)}"; only "${BOT_MODEL}" is supported`,
    );
  }
  return value;
}

async function readPersonaText(botDir: string, personaRelativePath: string): Promise<string> {
  const personaPath = join(botDir, personaRelativePath);
  try {
    return await readFile(personaPath, 'utf8');
  } catch {
    throw new Error(
      `bot folder "${botDir}" is missing its persona file at "${personaRelativePath}"`,
    );
  }
}

export async function loadBotConfig(botDir: string): Promise<BotConfig> {
  const manifest = await readBotManifest(botDir);
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`bot.json in "${botDir}" must be a JSON object`);
  }
  const manifestRecord = manifest as Record<string, unknown>;

  const name = requireStringField(manifestRecord, 'name', botDir);
  const displayName = requireStringField(manifestRecord, 'displayName', botDir);
  const roomTitle = requireStringField(manifestRecord, 'roomTitle', botDir);
  const skills = requireSkillsField(manifestRecord, botDir);
  const model = requireBotModel(manifestRecord, botDir);
  const persona =
    typeof manifestRecord.persona === 'string' && manifestRecord.persona.trim() !== ''
      ? manifestRecord.persona
      : DEFAULT_PERSONA_RELATIVE_PATH;

  const personaText = await readPersonaText(botDir, persona);

  return { name, displayName, roomTitle, persona, skills, model, personaText };
}
