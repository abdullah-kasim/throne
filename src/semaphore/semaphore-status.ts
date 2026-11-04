import { heldSlotsOf, listSemaphoreNames, readSlotCount, type HeldSlot } from "./semaphore-store.ts";

export interface SemaphoreStatus {
  readonly name: string;
  readonly slots: number;
  readonly heldSlots: readonly HeldSlot[];
}

export async function readSemaphoreStatuses(
  throneHome: string,
  name: string | undefined,
  flockExecutable?: string,
): Promise<SemaphoreStatus[]> {
  const names = name === undefined ? await listSemaphoreNames(throneHome) : [name];
  const statuses: SemaphoreStatus[] = [];
  for (const semaphore of names) {
    const slots = await readSlotCount(throneHome, semaphore);
    if (slots !== undefined) {
      statuses.push({ name: semaphore, slots, heldSlots: await heldSlotsOf(throneHome, semaphore, flockExecutable) });
    }
  }
  return statuses;
}

function renderHeldSlot({ slot, holder }: HeldSlot): string {
  return holder === undefined
    ? `  slot ${slot}: held, holder not recorded yet`
    : `  slot ${slot}: pid ${holder.pid}, started ${holder.startedAt}, ${holder.commandLine}`;
}

function renderOneSemaphore(status: SemaphoreStatus): string[] {
  return [`${status.name}: ${status.slots} slots, ${status.heldSlots.length} held`, ...status.heldSlots.map(renderHeldSlot)];
}

export function renderSemaphoreStatuses(statuses: readonly SemaphoreStatus[]): string {
  if (statuses.length === 0) return "no semaphores\n";
  return `${statuses.flatMap(renderOneSemaphore).join("\n")}\n`;
}

export function renderSemaphoreStatusesAsJson(statuses: readonly SemaphoreStatus[]): string {
  return `${JSON.stringify({ semaphores: statuses }, null, 2)}\n`;
}
