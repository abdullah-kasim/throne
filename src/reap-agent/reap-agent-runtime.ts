import { errorText } from "../shared-policy/error-text.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { REAL_DEPS } from "./dependencies.ts";
import { parseReapRequest, USAGE } from "./input.ts";
import { reapAgent } from "./lifecycle.ts";
import type { ReapDeps } from "./reap-agent.types.ts";

/** Runtime entrypoint used by Nest commands and startup reconciliation. */
export async function runReapAgent(
  args: string[],
  dependencies: ReapDeps = REAL_DEPS,
): Promise<number> {
  try {
    return await reapAgent(parseReapRequest(args), dependencies, new Set());
  } catch (error) {
    process.stderr.write(
      `reap-agent: ${errorText(error)}\n${renderEntranceRefusal({
        reason: "reap-agent entrance validation refused this invocation.",
        bypass: undefined,
        supervisorRoute:
          "Ask your supervisor for an allowed alternative invocation.",
      })}\n${USAGE}`,
    );
    return 1;
  }
}
