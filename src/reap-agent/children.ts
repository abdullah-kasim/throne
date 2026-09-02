import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { errorText } from '../shared-policy/error-text.ts';
import { IdentityLineReadStatus } from '../agentdata/identity-data.service.ts';
import type { ReapDeps } from './reap-agent.types.ts';

export interface ChildAgents {
  live: HerdrAgent[];
  nonLive: string[];
}

export async function discoverChildAgents(
  name: string,
  agents: HerdrAgent[],
  deps: ReapDeps,
): Promise<ChildAgents> {
  const registered = (await deps.listRegisteredAgents())
    .filter((candidate) => candidate !== name)
    .sort();
  const supervisors = await Promise.all(
    registered.map(async (candidate) => ({
      name: candidate,
      supervisor: await deps.readAgentSupervisor(candidate),
    })),
  );
  // A field-absent or unresolved supervisor read is never "== name" -- both
  // fall out of this filter the same way the pre-tristate collapsed-to-""
  // read already did, so an unreadable identity.md never falsely widens or
  // narrows who counts as this agent's child.
  const children = supervisors
    .filter(
      (candidate) =>
        candidate.supervisor.status === IdentityLineReadStatus.Found &&
        candidate.supervisor.value === name,
    )
    .map((candidate) => candidate.name);
  const liveByName = new Map<string, HerdrAgent>();
  for (const agent of agents) {
    if (agent.name !== undefined) {
      liveByName.set(agent.name, agent);
    }
  }
  return {
    live: children.flatMap((child) => {
      const agent = liveByName.get(child);
      return agent === undefined ? [] : [agent];
    }),
    nonLive: children.filter((child) => !liveByName.has(child)),
  };
}

export async function refuseForLiveChildren(
  name: string,
  liveChildren: HerdrAgent[],
  deps: ReapDeps,
): Promise<number> {
  let completed: Set<string>;
  try {
    completed = new Set(await deps.listCompletedAgents());
  } catch (error) {
    process.stderr.write(
      `reap-agent: cannot read completion reports while checking live child ` +
        `agents of "${name}" (${errorText(error)}) — refusing teardown.\n`,
    );
    return 1;
  }
  const childLines = liveChildren.map((child) => {
    const command = completed.has(child.name ?? '')
      ? `complete-agent ${child.name}`
      : `reap-agent ${child.name} --reason other`;
    return `  - ${child.name} (${child.agentStatus}) — ./bin/throne-cli ${command}`;
  });
  process.stderr.write(
    `reap-agent: refusing to reap "${name}" while live child agents still ` +
      `report to it:\n${childLines.join('\n')}\n` +
      `Run ./bin/throne-cli reap-agent ${name} --force --reason force only after review; ` +
      `--force cascades to all live children and may kill genuinely-working children.\n`,
  );
  return 1;
}

export function writeNonLiveChildren(
  name: string,
  children: string[],
): void {
  if (children.length === 0) {
    return;
  }
  process.stderr.write(
    `reap-agent: "${name}" had non-live registered children; they did not ` +
      `block teardown:\n${children.map((child) => `  - ${child}`).join('\n')}\n` +
      `Sweep completed children with ./bin/throne-cli complete-agent --all; ` +
      `inspect any remaining names before per-agent teardown.\n`,
  );
}

