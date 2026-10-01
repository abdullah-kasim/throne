import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotConfig } from '../bot-config.ts';

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bot-system-prompt.md');

export async function renderBotSystemPrompt(config: BotConfig): Promise<string> {
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  return template
    .replaceAll('{{BOT_NAME}}', config.name)
    .replaceAll('{{BOT_DISPLAY_NAME}}', config.displayName)
    .replaceAll('{{ROOM_TITLE}}', config.roomTitle)
    .replaceAll('{{SKILLS}}', config.skills.join(', '))
    .replaceAll('{{PERSONA}}', config.personaText.trim());
}
