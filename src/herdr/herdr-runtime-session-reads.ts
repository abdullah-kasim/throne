import { runHerdrInSession } from './herdr-client.ts';
import {
  parseAgentList,
  parsePaneProcessInfo,
  type HerdrAgent,
  type HerdrPaneProcessInfo,
} from './herdr-inventory.service.ts';

export async function getPaneProcessInfoInSession(
  sessionName: string,
  paneId: string,
  processBoundary?: Parameters<typeof runHerdrInSession>[2],
): Promise<HerdrPaneProcessInfo> {
  const { stdout } = await runHerdrInSession(
    sessionName,
    ['pane', 'process-info', '--pane', paneId],
    processBoundary,
  );
  return parsePaneProcessInfo(stdout);
}

export async function listAgentsInSession(
  sessionName: string,
  options: { timeoutMilliseconds?: number } = {},
): Promise<HerdrAgent[]> {
  const { stdout } = await runHerdrInSession(
    sessionName,
    ['agent', 'list'],
    undefined,
    options.timeoutMilliseconds === undefined ? undefined : options,
  );
  return parseAgentList(stdout);
}
