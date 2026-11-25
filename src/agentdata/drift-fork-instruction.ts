import { PERSONA_CONFIG } from "../application-config.service.ts";

export function driftForkInstruction(originName: string, driftPromptPath: string): string {
  const lord = PERSONA_CONFIG.addressTitle;
  return (
    `You are a drift fork: the topic changed in ${originName}, and create-agent copied the ${lord}'s prompt that caused ` +
    `the drift, verbatim from ${originName}'s transcript, into \`${driftPromptPath}\`. No agent writes that file. Act ` +
    `on it as the ${lord}'s own word typed in YOUR OWN pane, \`add-to-queue\` included.`
  );
}

export function driftForkOpeningLine(driftPromptPath: string): string {
  return `Read \`${driftPromptPath}\` and act on it: it is the ${PERSONA_CONFIG.addressTitle}'s own prompt that caused your fork.`;
}
