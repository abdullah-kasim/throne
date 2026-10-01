import { createHash } from 'node:crypto';
import {
  SERVE_ARM,
  SHADOW_ARM,
  SPLIT_HOOK_MODE,
  type HookMode,
  type RecallArm,
} from '../relevance-classifier/recall-user-config.ts';

function coinLandsOnServe(
  sessionId: string | undefined,
  hashOfPrompt: string,
): boolean {
  const coin = createHash('sha256')
    .update(`${sessionId ?? ''}\n${hashOfPrompt}`)
    .digest();
  return (coin[0] as number) % 2 === 0;
}

export function armForPrompt(
  hookMode: HookMode,
  sessionId: string | undefined,
  hashOfPrompt: string,
): RecallArm {
  if (hookMode !== SPLIT_HOOK_MODE) return hookMode;
  return coinLandsOnServe(sessionId, hashOfPrompt) ? SERVE_ARM : SHADOW_ARM;
}
