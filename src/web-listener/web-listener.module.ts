import { Module } from "@nestjs/common";
import { WhereIStandController } from "../where-i-stand/where-i-stand.controller.ts";
import { HealthController } from "./health.controller.ts";
import { MovedPagesController } from "./moved-pages.controller.ts";

@Module({
  controllers: [HealthController, MovedPagesController, WhereIStandController],
})
export class WebListenerModule {}
