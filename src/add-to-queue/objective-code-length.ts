import { HERDR_AGENT_NAME_MAX_LENGTH } from "../herdr/herdr-identity.service.ts";

const SHADOW_NAME_PREFIX = "shadow-";
const NAME_SEPARATOR = "-";
const LONGEST_GATE_SLICE_ID = "99a-conform-r2";

export const OBJECTIVE_CODE_MAX_LENGTH =
  HERDR_AGENT_NAME_MAX_LENGTH -
  SHADOW_NAME_PREFIX.length -
  NAME_SEPARATOR.length -
  LONGEST_GATE_SLICE_ID.length;

export function objectiveCodeLengthRefusal(code: string): string | undefined {
  if (code.length <= OBJECTIVE_CODE_MAX_LENGTH) return undefined;
  const unfitName = `${SHADOW_NAME_PREFIX}${code}${NAME_SEPARATOR}${LONGEST_GATE_SLICE_ID}`;
  return (
    `add-to-queue: objective code "${code}" is ${code.length} characters; the longest allowed is ` +
    `${OBJECTIVE_CODE_MAX_LENGTH}, because "${unfitName}" (${unfitName.length}) would not fit Herdr's ${HERDR_AGENT_NAME_MAX_LENGTH}`
  );
}
