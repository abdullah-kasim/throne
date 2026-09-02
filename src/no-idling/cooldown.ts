export const NO_IDLING_COOLDOWN_MS = 15 * 60 * 1000;

export function noIdlingFamilyKey(alphaName: string): string {
  return alphaName.toLowerCase();
}

export function shouldMessageFamily(
  familyKey: string,
  nowMs: number,
  lastMessageMs: number | undefined,
  cooldownMs: number = NO_IDLING_COOLDOWN_MS,
): boolean {
  return lastMessageMs === undefined || nowMs - lastMessageMs >= cooldownMs;
}
