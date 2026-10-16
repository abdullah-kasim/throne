import { readFile } from 'node:fs/promises';
import { claudeTranscriptPathFor } from '../session/runtime-model-acceptance.ts';

export interface ClaudeSessionSettings {
  readonly colour: string | undefined;
  readonly sessionName: string | undefined;
}

type TranscriptRecord = Readonly<Record<string, unknown>>;

const COLOUR_RECORD = { type: 'agent-color', valueField: 'agentColor' } as const;
const SESSION_NAME_RECORD = { type: 'custom-title', valueField: 'customTitle' } as const;

type SettingRecord = typeof COLOUR_RECORD | typeof SESSION_NAME_RECORD;

const UNKNOWN_SESSION_SETTINGS: ClaudeSessionSettings = {
  colour: undefined,
  sessionName: undefined,
};

export async function readClaudeSessionSettings(
  workingDirectory: string,
  sessionId: string | undefined,
  claudeProjectsDirectory?: string,
): Promise<ClaudeSessionSettings> {
  const transcript = await readSessionTranscript(
    workingDirectory,
    sessionId,
    claudeProjectsDirectory,
  );
  return transcript === undefined
    ? UNKNOWN_SESSION_SETTINGS
    : sessionSettingsRecordedIn(transcript);
}

async function readSessionTranscript(
  workingDirectory: string,
  sessionId: string | undefined,
  claudeProjectsDirectory: string | undefined,
): Promise<string | undefined> {
  try {
    const transcriptPath = await claudeTranscriptPathFor(
      workingDirectory,
      sessionId,
      claudeProjectsDirectory,
    );
    return transcriptPath === undefined ? undefined : await readFile(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }
}

function sessionSettingsRecordedIn(transcript: string): ClaudeSessionSettings {
  const records = transcriptRecords(transcript);
  return {
    colour: newestRecordedValue(records, COLOUR_RECORD),
    sessionName: newestRecordedValue(records, SESSION_NAME_RECORD),
  };
}

function transcriptRecords(transcript: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const line of transcript.split('\n')) {
    try {
      const parsedLine: unknown = JSON.parse(line);
      if (typeof parsedLine === 'object' && parsedLine !== null) {
        records.push(parsedLine as TranscriptRecord);
      }
    } catch {
      continue;
    }
  }
  return records;
}

function newestRecordedValue(
  records: readonly TranscriptRecord[],
  settingRecord: SettingRecord,
): string | undefined {
  const newestRecord = records.findLast((record) => record.type === settingRecord.type);
  const value = newestRecord?.[settingRecord.valueField];
  return typeof value === 'string' ? value : undefined;
}
