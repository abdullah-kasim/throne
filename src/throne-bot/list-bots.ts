import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface BotListing {
  name: string;
  registered: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listBots(botsRoot: string): Promise<BotListing[]> {
  let entries;
  try {
    entries = await readdir(botsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const listings: BotListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(botsRoot, entry.name);
    if (!(await fileExists(path.join(dir, 'bot.json')))) continue;
    listings.push({
      name: entry.name,
      registered: await fileExists(path.join(dir, 'credentials.json')),
    });
  }
  return listings.sort((a, b) => a.name.localeCompare(b.name));
}
