import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { hasStagingRecord, withoutStagingRecords } from "./staging-records.ts";

export async function forgejoHostNamesIn(text: string, forgejoRootUrl: string, dependencies: ForgeDependencies): Promise<string[]> {
  const tailnetAddress = await dependencies.readTailnetAddress();
  const forgejoHostNames = [new URL(forgejoRootUrl).hostname, ...(tailnetAddress === undefined ? [] : [tailnetAddress])];
  return forgejoHostNames.filter((name) => text.toLowerCase().includes(name.toLowerCase()));
}

export async function textSafeForGithub(
  text: string,
  description: string,
  forgejoRootUrl: string,
  dependencies: ForgeDependencies,
): Promise<string> {
  const stripped = withoutStagingRecords(text);
  if ((await forgejoHostNamesIn(stripped, forgejoRootUrl, dependencies)).length > 0) {
    throw new ForgeRefusal(
      `${description} names the Forgejo host, which must never reach GitHub; edit it to remove every Forgejo link, then run this again. Nothing was sent to GitHub.`,
    );
  }
  if (hasStagingRecord(stripped)) {
    throw new ForgeRefusal(
      `${description} holds a staging record that could not be removed, which must never reach GitHub; edit it to remove the record, then run this again. Nothing was sent to GitHub.`,
    );
  }
  return stripped;
}
