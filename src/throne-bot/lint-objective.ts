export interface LintObjectiveResult {
  ok: boolean;
  reason?: string;
}

const FINAL_STEP_PATTERN = /^throne send-agent \S+ "DONE \S+: .+"$/;

export function lintObjectiveBody(body: string): LintObjectiveResult {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (lastLine === undefined) {
    return { ok: false, reason: 'the objective body is empty' };
  }
  if (!FINAL_STEP_PATTERN.test(lastLine)) {
    return {
      ok: false,
      reason:
        'the objective\'s last step is not the literal completion callback ' +
        '(expected exactly: throne send-agent <bot-name> "DONE <objective-code>: ' +
        `<summary>"; got: "${lastLine}")`,
    };
  }
  return { ok: true };
}
