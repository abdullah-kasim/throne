import {
  REAP_REASON,
  REAP_REASONS,
  isReapReason,
} from '../agent-timings/reap-reason.ts';
import type {
  ParsedReapArgs,
  ReapRequest,
} from './reap-agent.types.ts';

export const FORCE_FLAG = '--force';
export const BYPASS_MARKER_FLAG = '--bypass-marker';
export const ARCHIVE_ABANDONED_UNMERGED_FLAG =
  '--archive-abandoned-unmerged';
export const SPAWN_PROCESS_GONE_FLAG = '--spawn-process-gone';
const REASON_FLAG = '--reason';

export const USAGE =
  `Usage: ./bin/throne-cli reap-agent <name> --reason <${REAP_REASONS.join('|')}> [--force] [${BYPASS_MARKER_FLAG}] [${ARCHIVE_ABANDONED_UNMERGED_FLAG}] [${SPAWN_PROCESS_GONE_FLAG}]\n` +
  'Plain reap accepts a completion-proven, non-working LIVE agent and refuses while live children report to the target.\n' +
  '--force cascades through live children first, may kill genuinely-working children, preserves an unmerged lifecycle with its exact ref and complete ledger, and permits absent-target cleanup without durable-default-branch retention; inspect before forcing.\n' +
  `${BYPASS_MARKER_FLAG} independently permits reaping a live agent whose latest message has no qualifying reapability claim; ${FORCE_FLAG} does not imply it.\n` +
  `--reason abandoned alone runs ordinary teardown, which succeeds for a branch with no unlanded work and otherwise refuses via the ancestry guard; it closes a queue-linked row as abandoned, and only an explicit update-queue --status open reopens it.\n` +
  `${ARCHIVE_ABANDONED_UNMERGED_FLAG} requires --reason abandoned and archives an intentionally unmerged lifecycle while retaining its exact local branch.\n` +
  `An agent whose spawn is still starting (spawn.json says its create-agent run has not finished, no opening prompt is recorded, and it is younger than the starting bound) is refused even with ${FORCE_FLAG}; ${SPAWN_PROCESS_GONE_FLAG} states that its create-agent process is gone and permits the reap.\n`;

function parseArgs(args: string[]): ParsedReapArgs {
  const parsed: ParsedReapArgs = {
    force: false,
    bypassMarker: false,
    archiveAbandonedUnmerged: false,
    spawnProcessGone: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === FORCE_FLAG) {
      parsed.force = true;
    } else if (arg === BYPASS_MARKER_FLAG) {
      parsed.bypassMarker = true;
    } else if (arg === ARCHIVE_ABANDONED_UNMERGED_FLAG) {
      parsed.archiveAbandonedUnmerged = true;
    } else if (arg === SPAWN_PROCESS_GONE_FLAG) {
      parsed.spawnProcessGone = true;
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
    parsed.archiveAbandonedUnmerged &&
    parsed.reason !== REAP_REASON.ABANDONED
  ) {
    throw new Error(
      `${ARCHIVE_ABANDONED_UNMERGED_FLAG} requires --reason abandoned`,
    );
  }
  return {
    name: parsed.name,
    force: parsed.force,
    bypassMarker: parsed.bypassMarker,
    archiveAbandonedUnmerged: parsed.archiveAbandonedUnmerged,
    spawnProcessGone: parsed.spawnProcessGone,
    reason: parsed.reason,
  };
}
