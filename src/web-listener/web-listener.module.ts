import { Module } from "@nestjs/common";
import { WhereIStandController } from "../where-i-stand/where-i-stand.controller.ts";
import { WhereIStandStoreController } from "../where-i-stand-store/where-i-stand-store.controller.ts";
import { WhereIStandStore } from "../where-i-stand-store/where-i-stand.store.ts";
import { HealthController } from "./health.controller.ts";
import { MovedPagesController } from "./moved-pages.controller.ts";

@Module({
  controllers: [HealthController, MovedPagesController, WhereIStandController, WhereIStandStoreController],
  providers: [WhereIStandStore],
})
export class WebListenerModule {}
