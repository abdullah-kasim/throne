import { closeTab } from '../src/herdr/herdr-tab.service.ts';
import { listTabs } from '../src/herdr/herdr-runtime.service.ts';

/**
 * The safety-net cleanup this replaces (`test/create-agent-codex-trust.canary.test.ts`'s
 * `rawHerdrRowByName`) looked a spawned pane up via `herdr agent list`, which only
 * lists panes herdr has detected as running a recognized harness. A pane whose
 * harness banner was never recognized — a bare stand-in launcher, or a pane that
 * crashed before printing its banner — never appears there, so that lookup
 * silently found nothing and the tab leaked. Looking tabs up by label via
 * `herdr tab list` instead finds every tab regardless of agent-detection state.
 */
export async function findLiveTabByLabel(
  label: string,
): Promise<{ tabId: string } | undefined> {
  const tabs = await listTabs();
  return tabs.find((tab) => tab.label === label);
}

/**
 * Closes the tab whose label exactly matches `label`, and only that tab —
 * never by prefix, regex, or fixture-shape heuristic. A no-op (no throw) when
 * no tab currently carries that label, so callers can invoke this from a
 * `finally`/`catch` block without a missing tab masking the original failure.
 */
export async function closeTabIfPresent(label: string): Promise<void> {
  const tab = await findLiveTabByLabel(label);
  if (tab === undefined) {
    return;
  }
  try {
    await closeTab(tab.tabId);
  } catch {
    // A concurrent teardown may have closed this same label first; the
    // caller's goal (the tab is gone) is already satisfied.
  }
}
