import { Module } from "@nestjs/common";
import {
  CreateAgentCommand,
  CreateAgentLegacyCommand,
} from "./create-agent.command.ts";
import { CustomHarnessService } from "./custom-harness.service.ts";
import { CustomHarnessService as LegacyCustomHarnessService } from "../create-agent-legacy/custom-harness.service.ts";
import { UsageReadersService } from "../shared-policy/usage-readers.service.ts";
import { HerdrTabService } from "../herdr/herdr-tab.service.ts";
import { HerdrCreateService } from "../herdr/herdr-create.service.ts";
import { HerdrHarnessService } from "../herdr/herdr-harness.service.ts";
import { HerdrInventoryService } from "../herdr/herdr-inventory.service.ts";
import { HerdrClientService } from "../herdr/herdr-client.ts";

@Module({
  providers: [
    CreateAgentCommand,
    CreateAgentLegacyCommand,
    CustomHarnessService,
    LegacyCustomHarnessService,
    UsageReadersService,
    {
      provide: HerdrClientService,
      useFactory: () => new HerdrClientService(),
    },
    HerdrInventoryService,
    {
      provide: HerdrTabService,
      useFactory: () => new HerdrTabService(),
    },
    HerdrCreateService,
    HerdrHarnessService,
  ],
})
export class CreateAgentModule {}
