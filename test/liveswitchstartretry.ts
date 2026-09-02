export const LIVE_START_BUSY_MAX_ATTEMPTS = 12;
export const LIVE_START_BUSY_RETRY_DELAY_MS = 1_000;

/** `herdr`'s own rethrown start failure. */
const RAW_START_BUSY =
  /^herdr agent start \S+ [^\n]* failed \(agent_pane_busy\): (\{[^\n]*\})$/;

/** `startAgent`'s wrapped exhaustion of its own bound. */
const EXHAUSTED_START_BUSY =
  /^herdr agent start for "[^"\n]+" was rejected as pane-busy on all \d+ bounded attempts against pane "[^"\n]+", whose shell had already executed the readiness sentinel; no agent was registered$/;

/**
 * True only when the whole stderr is the pre-registration `agent_pane_busy`
 * start failure. Retained-registration and assumed-filled-delivery reports quote
 * the same herdr error, so anything beyond that single line is not retryable.
 */
export function isPreRegistrationPaneBusyStartFailure(stderr: string): boolean {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length !== 1) return false;
  const line = lines[0];
  if (EXHAUSTED_START_BUSY.test(line)) return true;
  const raw = RAW_START_BUSY.exec(line);
  if (raw === null) return false;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw[1]);
  } catch {
    return false;
  }
  if (typeof envelope !== 'object' || envelope === null) return false;
  const record = envelope as Record<string, unknown>;
  if (record.id !== 'cli:agent:start') return false;
  const failure = record.error;
  if (typeof failure !== 'object' || failure === null) return false;
  return (failure as Record<string, unknown>).code === 'agent_pane_busy';
}
