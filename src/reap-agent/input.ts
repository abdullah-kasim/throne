import {
  REAP_REASON,
  REAP_REASONS,
  isReapReason,
} from '../agent-timings/reap-reason.ts';
import type {
  ParsedReapArgs,
  ReapRequest,
} from './reap-agent.types.ts';

export const MEMORY_PATH = 'agent_docs/MEMORY';
export const FORCE_FLAG = '--force';
export const BYPASS_MARKER_FLAG = '--bypass-marker';
export const FORCE_DISCARD_MEMORIES_FLAG = '--force-discard-memories';
export const ARCHIVE_CANCELLED_UNMERGED_FLAG =
  '--archive-cancelled-unmerged';
const REASON_FLAG = '--reason';

export const USAGE =
  `Usage: ./bin/throne-cli reap-agent <name> --reason <${REAP_REASONS.join('|')}> [--force] [${BYPASS_MARKER_FLAG}] [${FORCE_DISCARD_MEMORIES_FLAG}] [${ARCHIVE_CANCELLED_UNMERGED_FLAG}]\n` +
  'Plain reap accepts a completion-proven, non-working LIVE agent and refuses while live children report to the target.\n' +
  '--force cascades through live children first, may kill genuinely-working children, preserves an unmerged lifecycle with its exact ref and complete ledger, and permits absent-target cleanup without durable-default-branch retention; inspect before forcing.\n' +
  `${BYPASS_MARKER_FLAG} independently permits reaping a live agent whose latest message has no qualifying reapability claim; ${FORCE_FLAG} does not imply it.\n` +
  `--reason cancelled alone runs ordinary teardown, which succeeds for a branch with no unlanded work and otherwise refuses via the ancestry guard.\n` +
  `${ARCHIVE_CANCELLED_UNMERGED_FLAG} requires --reason cancelled and archives an intentionally unmerged lifecycle while retaining its exact local branch.\n` +
  `${FORCE_DISCARD_MEMORIES_FLAG} explicitly permits destroying uncommitted files under ${MEMORY_PATH}.\n`;

function parseArgs(args: string[]): ParsedReapArgs {
  const parsed: ParsedReapArgs = {
    force: false,
    bypassMarker: false,
    forceDiscardMemories: false,
    archiveCancelledUnmerged: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === FORCE_FLAG) {
      parsed.force = true;
    } else if (arg === BYPASS_MARKER_FLAG) {
      parsed.bypassMarker = true;
    } else if (arg === FORCE_DISCARD_MEMORIES_FLAG) {
      parsed.forceDiscardMemories = true;
    } else if (arg === ARCHIVE_CANCELLED_UNMERGED_FLAG) {
      parsed.archiveCancelledUnmerged = true;
    } else if (arg === REASON_FLAG) {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${REASON_FLAG} requires a value`);
      }
      if (!isReapReason(value)) {
        throw new Error(
          `invalid reap reason "${value}"; valid reasons: ${REAP_REASONS.join(', ')}`,
        );
      }
      parsed.reason = value;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag "${arg}"`);
    } else if (parsed.name === undefined) {
      parsed.name = arg;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }
  return parsed;
}

export function parseReapRequest(args: string[]): ReapRequest {
  const parsed = parseArgs(args);
  if (parsed.name === undefined) {
    throw new Error('missing <name>');
  }
  if (parsed.reason === undefined) {
    throw new Error(
      `missing required ${REASON_FLAG}; valid reasons: ${REAP_REASONS.join(', ')}`,
    );
  }
  if (
    parsed.archiveCancelledUnmerged &&
    parsed.reason !== REAP_REASON.CANCELLED
  ) {
    throw new Error(
      `${ARCHIVE_CANCELLED_UNMERGED_FLAG} requires --reason cancelled`,
    );
  }
  return {
    name: parsed.name,
    force: parsed.force,
    bypassMarker: parsed.bypassMarker,
    forceDiscardMemories: parsed.forceDiscardMemories,
    archiveCancelledUnmerged: parsed.archiveCancelledUnmerged,
    reason: parsed.reason,
  };
}
