import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CLAIM_SEEN_BASENAME = "claim-seen.json";

export async function readClaimSeenAt(agentName: string, dataDir: string): Promise<Date | undefined> {
  try {
    const { seenAt } = JSON.parse(
      await readFile(path.join(dataDir, agentName, CLAIM_SEEN_BASENAME), "utf8"),
    ) as { seenAt?: string };
    const time = new Date(seenAt ?? "");
    return Number.isNaN(time.getTime()) ? undefined : time;
  } catch {
    return undefined;
  }
}

export async function recordClaimSeen(agentName: string, dataDir: string, seenAt: Date): Promise<Date> {
  const recorded = await readClaimSeenAt(agentName, dataDir);
  if (recorded !== undefined) return recorded;
  await mkdir(path.join(dataDir, agentName), { recursive: true });
  await writeFile(
    path.join(dataDir, agentName, CLAIM_SEEN_BASENAME),
    `${JSON.stringify({ seenAt: seenAt.toISOString() })}\n`,
  );
  return seenAt;
}
