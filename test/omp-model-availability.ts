// A real-omp test needs a model, and the harness deliberately points omp at a
// scratch agent directory (OMP_AGENT_DIR/PI_CODING_AGENT_DIR) so it cannot
// touch the operator's own sessions or credentials. That isolation costs the
// credentials too: measured 2026-08-27, `omp models --json` under a scratch
// agent dir returns `{"models":[]}`.
//
// With no model, omp answers `No model selected` and never delivers the
// payload — so a test asserting on delivery is grading the absence of
// credentials rather than the code. Skip it and say so, instead of failing on
// an environment fact or, worse, passing because the throne side reported
// "delivered" for a payload that never arrived.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MILLISECONDS = 60_000;

/**
 * The reason a real-omp test cannot run in `environment`, or `undefined` when a
 * model is available. The returned string is meant to be handed straight to
 * `t.skip()`.
 */
export async function ompModelSkipReason(
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  let raw: string;
  try {
    const { stdout } = await execFileAsync("omp", ["models", "--json"], {
      env: environment,
      timeout: PROBE_TIMEOUT_MILLISECONDS,
    });
    raw = stdout;
  } catch (error) {
    return `omp models could not be probed (${String(error)}); no model can be assumed available`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `omp models emitted unparseable JSON; no model can be assumed available`;
  }
  if (parsed === null || typeof parsed !== "object" || !("models" in parsed)) {
    return "omp models emitted no models field; no model can be assumed available";
  }
  const models = parsed.models;
  if (!Array.isArray(models)) {
    return "omp models emitted a non-array models field; no model can be assumed available";
  }
  if (models.length === 0) {
    return "no omp models are available in this environment (a scratch OMP_AGENT_DIR carries no credentials), so a real omp cannot answer a delivery";
  }
  return undefined;
}
