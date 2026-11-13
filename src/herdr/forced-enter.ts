import type { ActiveComposerSnapshot } from '../codex-screen/composer/composer.types.ts';
import type { HerdrAgent } from './herdr-inventory.service.ts';
import { pressEnterIgnoringLocks } from './herdr-client.ts';
import { observeSupportedScreen, supportedComposerHarness } from './herdr-screen.service.ts';
import { defaultSubmitToAgentDeps } from './herdr-send.service.ts';

const COMPOSER_READ_TIMEOUT_MS = 5_000;

export interface ForcedEnterDependencies {
  readComposer: (agent: HerdrAgent) => Promise<ActiveComposerSnapshot | undefined>;
  pressEnter: (paneId: string) => Promise<void>;
}

export class ForcedEnterRefusedError extends Error {
  override readonly name = 'ForcedEnterRefusedError';
}

export async function readComposerWithinTimeout(
  agent: HerdrAgent,
): Promise<ActiveComposerSnapshot | undefined> {
  const harness = supportedComposerHarness(agent.agent);
  if (harness === undefined) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<ActiveComposerSnapshot>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'unavailable' }), COMPOSER_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      observeSupportedScreen(agent, harness, defaultSubmitToAgentDeps(agent)).then(
        (screen) => screen.activeComposer,
      ),
      timedOut,
    ]);
  } catch {
    return { state: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

const REAL_DEPENDENCIES: ForcedEnterDependencies = {
  readComposer: readComposerWithinTimeout,
  pressEnter: (paneId) => pressEnterIgnoringLocks(paneId),
};

export async function forceEnter(
  agent: HerdrAgent,
  dependencies: ForcedEnterDependencies = REAL_DEPENDENCIES,
): Promise<void> {
  const name = agent.name ?? agent.paneId;
  const composer = await dependencies.readComposer(agent);
  if (composer?.state === 'modal') {
    throw new ForcedEnterRefusedError(`a dialog covers ${name}'s input box; pressed nothing`);
  }
  if (composer?.state === 'unavailable') {
    throw new ForcedEnterRefusedError(`${name}'s input box could not be read; pressed nothing`);
  }
  await dependencies.pressEnter(agent.paneId);
}
