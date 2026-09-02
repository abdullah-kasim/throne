import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadPersonaConfig } from '../application-config.service.ts';
import { canonicalizeIdentityRole } from '../shared-policy/identity-role-casing.ts';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import { RUNTIME_THRONE_ROOT } from '../shared-policy/runtime-throne-root.ts';

export const AGENT_STATUSES_DATA_DIRECTORY = RUNTIME_DATA_DIR;

export const AGENT_STATUSES_PERSONA_CONFIG_PATH = path.resolve(
  RUNTIME_THRONE_ROOT,
  'config.user.ts',
);

const ROLE_LINE_PREFIX = '- **Role:** ';

export interface AgentStatusesRegistryDependencies {
  readonly access: typeof access;
  readonly readFile: typeof readFile;
  readonly readdir: typeof readdir;
}

const DEFAULT_REGISTRY_DEPENDENCIES: AgentStatusesRegistryDependencies = {
  access,
  readFile,
  readdir,
};

async function fileExists(
  filePath: string,
  dependencies: AgentStatusesRegistryDependencies,
): Promise<boolean> {
  try {
    await dependencies.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isMissingDataDirectory(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readDataDirectory(
  dataDirectory: string,
  dependencies: AgentStatusesRegistryDependencies,
) {
  try {
    return await dependencies.readdir(dataDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDataDirectory(error)) {
      return [];
    }
    throw error;
  }
}

async function hasCompletionReport(
  agentDirectory: string,
  dependencies: AgentStatusesRegistryDependencies,
): Promise<boolean> {
  if (await fileExists(path.join(agentDirectory, 'REPORT.md'), dependencies)) {
    return true;
  }
  let childEntries;
  try {
    childEntries = await dependencies.readdir(agentDirectory, {
      withFileTypes: true,
    });
  } catch {
    return false;
  }
  for (const childEntry of childEntries) {
    if (
      childEntry.isDirectory() &&
      (await fileExists(
        path.join(agentDirectory, childEntry.name, 'REPORT.md'),
        dependencies,
      ))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A directory counts as a registered agent when it carries EITHER durable
 * identity (`identity.md`, written at spawn) OR a completion report
 * (`REPORT.md`, the durable COMPLETE signal). Requiring identity.md alone
 * made a dir invisible to the whole roster the moment identity.md was
 * missing or already cleaned up — even with REPORT.md sitting right there —
 * so `complete-agent --all`'s COMPLETE sweep silently skipped it while
 * `reap-agent <name>` (which never checks identity.md) reaped it fine.
 */
export async function listRegisteredAgentNames(
  dataDirectory: string = AGENT_STATUSES_DATA_DIRECTORY,
  dependencies: AgentStatusesRegistryDependencies = DEFAULT_REGISTRY_DEPENDENCIES,
): Promise<string[]> {
  const entries = await readDataDirectory(dataDirectory, dependencies);
  const registeredNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const agentDirectory = path.join(dataDirectory, entry.name);
    if (
      (await fileExists(path.join(agentDirectory, 'identity.md'), dependencies)) ||
      (await hasCompletionReport(agentDirectory, dependencies))
    ) {
      registeredNames.push(entry.name);
    }
  }
  return registeredNames.sort();
}

/**
 * Completion is decided solely by the durable COMPLETE signal, REPORT.md —
 * matching reap-agent's own view of the same directory. identity.md presence
 * is registration evidence, not a second completion precondition.
 */
export async function listCompletedAgentNames(
  dataDirectory: string = AGENT_STATUSES_DATA_DIRECTORY,
  dependencies: AgentStatusesRegistryDependencies = DEFAULT_REGISTRY_DEPENDENCIES,
): Promise<string[]> {
  const entries = await readDataDirectory(dataDirectory, dependencies);
  const completedNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const agentDirectory = path.join(dataDirectory, entry.name);
    if (await hasCompletionReport(agentDirectory, dependencies)) {
      completedNames.push(entry.name);
    }
  }
  return completedNames.sort();
}

export async function readAgentStatusRole(
  name: string,
  dataDirectory: string = AGENT_STATUSES_DATA_DIRECTORY,
  dependencies: AgentStatusesRegistryDependencies = DEFAULT_REGISTRY_DEPENDENCIES,
): Promise<string> {
  let identity: string;
  try {
    identity = await dependencies.readFile(
      path.join(dataDirectory, name, 'identity.md'),
      'utf8',
    );
  } catch {
    return '';
  }
  const roleLine = identity
    .split('\n')
    .find((line) => line.startsWith(ROLE_LINE_PREFIX));
  const rawRole = roleLine?.slice(ROLE_LINE_PREFIX.length).trim() ?? '';
  // Read-boundary normalization: covers every EXISTING identity.md already
  // on disk with inconsistent casing, regardless of what the writer emits
  // going forward (see `writeIdentity`'s own canonicalization for new
  // agents).
  return rawRole === '' ? '' : canonicalizeIdentityRole(rawRole);
}

/**
 * The Regent's display title, resolved through the one persona-config schema
 * and validator (`application-config.service.ts`) rather than a second
 * hand-rolled copy: an absent config file yields the committed default; a
 * present-but-invalid one throws naming the file and field.
 */
export async function loadAgentStatusesRegentTitle(
  configPath: string = AGENT_STATUSES_PERSONA_CONFIG_PATH,
): Promise<string> {
  return (await loadPersonaConfig(configPath)).tierTitles.regent;
}
