import type {
  HerdrPane,
  HerdrPaneProcessInfo,
  HerdrTab,
} from "./herdr-inventory.service.ts";
import { paneHasLiveHarnessProcess } from "./herdr-process-detection.ts";
import { exactLabelTabs } from "./herdr-restored-tab-inspection.ts";
import {
  getPaneProcessInfo,
  listPanes,
  listTabs,
} from "./herdr-runtime.service.ts";

export interface RestoredAgentTab {
  tabId: string;
  paneId: string;
}

export interface RestoredAgentTabDeps {
  listTabs: () => Promise<HerdrTab[]>;
  listPanes: () => Promise<HerdrPane[]>;
  getPaneProcessInfo: (paneId: string) => Promise<HerdrPaneProcessInfo>;
}

export const REAL_RESTORED_AGENT_TAB_DEPS: RestoredAgentTabDeps = {
  listTabs,
  listPanes,
  getPaneProcessInfo,
};

export async function findRestoredAgentTab(
  label: string,
  deps: RestoredAgentTabDeps = REAL_RESTORED_AGENT_TAB_DEPS,
): Promise<RestoredAgentTab | null> {
  const labelledTabs = exactLabelTabs(await deps.listTabs(), label);
  if (labelledTabs.length !== 1) return null;
  const { tabId } = labelledTabs[0]!;
  const tabPanes = (await deps.listPanes()).filter(
    (pane) => pane.tabId === tabId,
  );
  if (tabPanes.length !== 1) return null;
  const { paneId } = tabPanes[0]!;
  if (paneHasLiveHarnessProcess(await deps.getPaneProcessInfo(paneId))) {
    return null;
  }
  return { tabId, paneId };
}
