import { Injectable } from '@nestjs/common';
import { HerdrClientService } from './herdr-client.ts';
import {
  claudeTextboxClearance,
  waitForStableClaudeResidentRepresentation,
} from './herdr-claude.service.ts';
import {
  codexScreenShowsComposerQueueHint,
  codexTextboxClearance,
  waitForCodexDraftRepresentation,
} from './herdr-codex.service.ts';
import {
  dismissOpenCodeMessageActionsModal,
  opencodeTextboxClearance,
  waitForStableOpenCodeResidentRepresentation,
} from './herdr-opencode.service.ts';

/** Nest boundary for harness-specific Herdr interaction behavior. */
@Injectable()
export class HerdrHarnessService {
  private readonly client: HerdrClientService;

  constructor(client: HerdrClientService) {
    this.client = client;
  }

  sendText(target: string, text: string): Promise<void> {
    return this.client.sendText(target, text);
  }

  readonly claudeTextboxClearance = claudeTextboxClearance;
  readonly codexTextboxClearance = codexTextboxClearance;
  readonly opencodeTextboxClearance = opencodeTextboxClearance;
  readonly codexScreenShowsComposerQueueHint = codexScreenShowsComposerQueueHint;

  waitForStableClaudeResidentRepresentation(...args: Parameters<typeof waitForStableClaudeResidentRepresentation>) {
    return waitForStableClaudeResidentRepresentation(...args);
  }

  waitForCodexDraftRepresentation(...args: Parameters<typeof waitForCodexDraftRepresentation>) {
    return waitForCodexDraftRepresentation(...args);
  }

  waitForStableOpenCodeResidentRepresentation(...args: Parameters<typeof waitForStableOpenCodeResidentRepresentation>) {
    return waitForStableOpenCodeResidentRepresentation(...args);
  }

  dismissOpenCodeMessageActionsModal(...args: Parameters<typeof dismissOpenCodeMessageActionsModal>) {
    return dismissOpenCodeMessageActionsModal(...args);
  }
}

