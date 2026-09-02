// The live-court reach for `switch-persona` — Lord's ruling, 2026-08-08:
// "switching personas will also switch live agents". Config alone cannot
// reach an already-running agent (`PERSONA_CONFIG` is resolved once per
// process at module load), so the only mechanism that can is a message.
//
// EDGE 1 (the dangerous one): this module NEVER calls `clearBlockedMarker`,
// by construction — it uses `submitToAgent` directly, not the `send-agent`
// CLI wrapper (whose command layer clears markers as a deliberate BLK
// behaviour for genuine progress). A persona update is administrative
// re-dress, not progress, so it must be structurally incapable of clearing a
// blocked marker. See `switch-persona-broadcast.spec.ts`'s blocked-marker
// proof.
//
// EDGE 2: the delivered text states plainly, up front, that this is a
// vocabulary-only update — never a nudge, an assignment, or permission to
// resume idle work.
//
// EDGE 3: delivery is immediate to every live registered agent (mirrors
// `send-agent`'s own resident-draft-safe, per-recipient-serialized delivery
// guarantee — a mid-slice agent seeing a queued, clearly-labelled prompt is
// the same safety story `send-agent` already relies on). The result records,
// per agent, whether it was updated or could not be reached, so a partial
// broadcast is legible rather than silently declared total.

import type { PersonaConfig, RoleplayPresetName } from '../application-config.service.ts';

export interface PersonaBroadcastDeps<Agent extends { name?: string } = { name?: string }> {
  readonly senderName: string;
  readonly listRegisteredAgentNames: () => Promise<readonly string[]>;
  readonly resolveAgent: (name: string) => Promise<Agent>;
  readonly submitToAgent: (
    agent: Agent,
    senderName: string,
    prompt: string,
  ) => Promise<void>;
  /** Names never messaged — always includes the switch's own sender, so the
   *  broadcaster never delivers a persona update to itself mid-command. */
  readonly excludeNames?: readonly string[];
}

export interface PersonaBroadcastResult {
  readonly updated: readonly string[];
  readonly unreachable: readonly { name: string; reason: string }[];
}

export function buildPersonaSwitchMessage(
  presetName: RoleplayPresetName,
  config: PersonaConfig,
): string {
  return [
    '[Persona vocabulary update — NOT a nudge, NOT new work, NOT permission ' +
      'to resume idle work. If you are idle or blocked, stay that way; only ' +
      'this message is new.]',
    `The active roleplay persona is now "${presetName}". From now on:`,
    config.roleplayPrompt,
    `Address the human as "${config.addressTitle}". Tier titles in prose: ` +
      `${config.tierTitles.regent} (Regent), ${config.tierTitles.alpha} ` +
      `(Alpha), ${config.tierTitles.shadow} (Shadow). Your organization is ` +
      `called "${config.throneTitle}", a unit of work is a "${config.campaignTitle}".`,
    'This is vocabulary only: your agent name, role, ledger path, ' +
      'supervisor, and assignments are unchanged.',
  ].join('\n\n');
}

/** Delivers the persona-update message to every currently registered live
 *  agent except `deps.excludeNames`. Never touches blocked-marker state.
 *  A resolution or delivery failure for one agent is recorded and does not
 *  stop delivery to the rest. */
export async function broadcastPersonaSwitch<Agent extends { name?: string }>(
  presetName: RoleplayPresetName,
  config: PersonaConfig,
  deps: PersonaBroadcastDeps<Agent>,
): Promise<PersonaBroadcastResult> {
  const names = await deps.listRegisteredAgentNames();
  const message = buildPersonaSwitchMessage(presetName, config);
  const updated: string[] = [];
  const unreachable: { name: string; reason: string }[] = [];
  const excluded = new Set(deps.excludeNames ?? []);

  for (const name of names) {
    if (excluded.has(name)) continue;
    try {
      const agent = await deps.resolveAgent(name);
      await deps.submitToAgent(agent, deps.senderName, message);
      updated.push(name);
    } catch (cause) {
      unreachable.push({
        name,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { updated, unreachable };
}
