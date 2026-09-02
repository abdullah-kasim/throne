import type { HerdrPane } from './herdr-inventory.service.ts';
import type { ResumeRegisteredAgentInRestoredTabDeps } from './herdr-create.contracts.ts';

/** Remove panes left behind when a restored tab is reclaimed for an agent. */
export async function trimPreExistingRestoredPanes(
  panes: HerdrPane[],
  newAgentPaneId: string | undefined,
  deps: Pick<ResumeRegisteredAgentInRestoredTabDeps, 'closePane'>,
): Promise<void> {
  if (newAgentPaneId === undefined) return;
  for (const pane of panes) {
    if (pane.paneId === newAgentPaneId) continue;
    try {
      await deps.closePane(pane.paneId);
    } catch {}
  }
}
