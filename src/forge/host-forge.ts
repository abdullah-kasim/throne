import {
  LAUNCHD_AGENT_NAMES,
  SYSTEMD_UNIT_NAMES,
} from "../install-services/service-unit-renderer.service.ts";
import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal, messageOf } from "./forge-refusal.ts";
import { readForgejoSite } from "./forgejo-site.ts";

export const FORGE = { forgejo: "forgejo", github: "github" } as const;
export type Forge = (typeof FORGE)[keyof typeof FORGE];

export type HostForgeDecision =
  | { readonly forge: typeof FORGE.forgejo; readonly url: string; readonly reason: string }
  | { readonly forge: typeof FORGE.github; readonly url: null; readonly reason: string };

const FORGEJO_VERSION_PROBE_TIMEOUT_MILLISECONDS = 5_000;

export function forgejoApiUrl(rootUrl: string, apiPath: string): string {
  return `${rootUrl}api/v1/${apiPath}`;
}

function forgejoUnitInspectionCommand(): string {
  return process.platform === "darwin"
    ? `launchctl print gui/$(id -u)/${LAUNCHD_AGENT_NAMES.FORGEJO.label}`
    : `systemctl --user status ${SYSTEMD_UNIT_NAMES.FORGEJO}`;
}

async function whyForgejoDoesNotAnswer(rootUrl: string, dependencies: ForgeDependencies): Promise<string | undefined> {
  try {
    const response = await dependencies.fetch(forgejoApiUrl(rootUrl, "version"), {
      signal: AbortSignal.timeout(FORGEJO_VERSION_PROBE_TIMEOUT_MILLISECONDS),
    });
    return response.ok ? undefined : `HTTP ${response.status}`;
  } catch (error) {
    return messageOf(error);
  }
}

export async function decideHostForge(dependencies: ForgeDependencies): Promise<HostForgeDecision> {
  const site = await readForgejoSite();
  if (site === undefined) {
    return { forge: FORGE.github, url: null, reason: "this host has no Forgejo install marker" };
  }
  const versionUrl = forgejoApiUrl(site.rootUrl, "version");
  const failure = await whyForgejoDoesNotAnswer(site.rootUrl, dependencies);
  if (failure !== undefined) {
    throw new ForgeRefusal(
      `Forgejo is installed on this host but ${versionUrl} does not answer (${failure}); ` +
        `nothing is sent to GitHub instead. Inspect the unit with: ${forgejoUnitInspectionCommand()}`,
    );
  }
  return { forge: FORGE.forgejo, url: site.rootUrl, reason: `the install marker is present and ${versionUrl} answers` };
}
