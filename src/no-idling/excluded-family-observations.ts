import type { FullyIdleFamily, LastMessageTagState } from './idle-family.ts';

function exclusionReason(state: LastMessageTagState | undefined): string | undefined {
  if (state === undefined) return undefined;
  switch (state.kind) {
    case 'reapable-failed': return 'its last message is REAPABLE_FAIL-marked; supervisor repair is required before reap';
    case 'reapable': return 'its last message carries a supported reapability JSON claim';
    case 'blocked': return 'its latest message is the standalone JSON {"blocked":true}';
    case 'busy': return `its pane reports ${state.running} (herdr cannot see background work)`;
    case 'unreadable': return 'its last message could not be read';
    case 'unmarked': return undefined;
  }
}

export function noteExcludedFamilies(
  write: (text: string) => void,
  statusFamilies: readonly FullyIdleFamily[],
  families: readonly FullyIdleFamily[],
  lastMessageTags: ReadonlyMap<string, LastMessageTagState>,
  observations: Set<string>,
): void {
  const current = new Set<string>();
  for (const statusFamily of statusFamilies) {
    if (families.some((family) => family.alpha === statusFamily.alpha)) continue;
    const reasons = [statusFamily.alpha, ...statusFamily.idleChildren]
      .map((member) => ({ member, reason: exclusionReason(lastMessageTags.get(member)) }))
      .filter((entry): entry is { member: string; reason: string } => entry.reason !== undefined)
      .map((entry) => `${entry.member}: ${entry.reason}`);
    if (reasons.length === 0) continue;
    const observation = `${statusFamily.alpha}:${reasons.join('; ')}`;
    current.add(observation);
    if (observations.has(observation)) continue;
    observations.add(observation);
    write(`no-idling: family ${statusFamily.alpha} excluded from the fully-idle set (${reasons.join('; ')}) — not messaged\n`);
  }
  for (const observation of observations) {
    if (!current.has(observation)) observations.delete(observation);
  }
}
