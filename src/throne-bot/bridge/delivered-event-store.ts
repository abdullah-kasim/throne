import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DeliveredEventStore } from './bridge.types.ts';

async function readDeliveredEventIds(filePath: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

export function createFileDeliveredEventStore(
  filePath: string,
): DeliveredEventStore {
  return {
    async hasDelivered(eventId: string): Promise<boolean> {
      const ids = await readDeliveredEventIds(filePath);
      return ids.has(eventId);
    },
    async markDelivered(eventId: string): Promise<void> {
      const ids = await readDeliveredEventIds(filePath);
      ids.add(eventId);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify([...ids]), 'utf8');
    },
  };
}
