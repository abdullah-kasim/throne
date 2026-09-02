import { Module } from '@nestjs/common';
import { CodexTrustService } from './codex-trust.service.ts';

@Module({ providers: [CodexTrustService], exports: [CodexTrustService] })
export class CodexTrustModule {}
