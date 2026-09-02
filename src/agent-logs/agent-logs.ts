import { AgentResolutionError } from '../herdr/herdr-identity-contracts.ts';
import type { ReadOptions, ReadSource } from '../herdr/herdr-inventory.service.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';

export const AGENT_LOG_READ_SOURCES: readonly ReadSource[] = [
  'visible',
  'recent',
  'recent-unwrapped',
];

const DEFAULT_SOURCE: ReadSource = 'recent';
const DEFAULT_LINES = 200;

export interface AgentLogsRequest {
  readonly name: string;
  readonly options: Required<Pick<ReadOptions, 'source' | 'lines'>>;
}

export type AgentLogsReader = (
  name: string,
  options: ReadOptions,
) => Promise<string>;

function isReadSource(value: string): value is ReadSource {
  return (AGENT_LOG_READ_SOURCES as readonly string[]).includes(value);
}

export function parseAgentLogsRequest(
  args: readonly string[],
): AgentLogsRequest | string {
  const positional: string[] = [];
  let lines = DEFAULT_LINES;
  let source: ReadSource = DEFAULT_SOURCE;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--lines') {
      const value = args[++i];
      const parsed = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return `--lines requires a positive integer, got "${value}"\n`;
      }
      lines = parsed;
    } else if (arg === '--source') {
      const value = args[++i];
      if (value === undefined || !isReadSource(value)) {
        return (
          `--source must be one of ${AGENT_LOG_READ_SOURCES.join('|')}, ` +
          `got "${value}"\n`
        );
      }
      source = value;
    } else {
      positional.push(arg!);
    }
  }

  const [name] = positional;
  if (name === undefined) {
    return (
      'Usage: ./bin/throne-cli agent-logs <name> [--lines N] ' +
      `[--source ${AGENT_LOG_READ_SOURCES.join('|')}]\n`
    );
  }
  return { name, options: { source, lines } };
}

export async function runAgentLogs(
  args: readonly string[],
  readAgent: AgentLogsReader,
): Promise<number> {
  const request = parseAgentLogsRequest(args);
  if (typeof request === 'string') {
    process.stderr.write(request);
    process.stderr.write(
      `${renderEntranceRefusal({
        reason: 'agent-logs entrance validation refused the invocation.',
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 1;
  }

  try {
    const output = await readAgent(request.name, request.options);
    process.stdout.write(output);
    if (!output.endsWith('\n')) process.stdout.write('\n');
    return 0;
  } catch (error) {
    if (error instanceof AgentResolutionError) {
      process.stderr.write(`${error.message}\n`);
      process.stderr.write(
        `${renderEntranceRefusal({
          reason: 'agent-logs could not resolve the requested agent.',
          bypass: undefined,
          supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
        })}\n`,
      );
      return 1;
    }
    throw error;
  }
}
