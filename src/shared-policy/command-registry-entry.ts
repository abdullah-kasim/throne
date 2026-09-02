import type { Type } from "@nestjs/common";

export type CommandVisibility = "public" | "internal";

export interface CommandRegistryEntry {
  readonly name: string;
  readonly provider: Type<unknown>;
  readonly visibility: CommandVisibility;
  readonly migrated: boolean;
  readonly description?: string;
  /**
   * True when the command runtime owns its richer, feature-aware help output.
   * The uniform execute guard defers to that runtime instead of replacing it.
   */
  readonly ownHelp?: boolean;
}
