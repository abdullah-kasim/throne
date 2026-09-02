import { Module } from "@nestjs/common";
import { CodexScreenService } from "./codex-screen.ts";
import { ComposerModule } from "./composer/composer.module.ts";

@Module({
  imports: [ComposerModule],
  providers: [CodexScreenService],
  exports: [CodexScreenService],
})
export class CodexScreenModule {}
