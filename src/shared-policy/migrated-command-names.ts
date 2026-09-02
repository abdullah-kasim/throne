import { migratedCommandNames } from "./command-registry.ts";

/**
 * Commands descended from a pre-Nest legacy shell command, as opposed to
 * ones authored directly against Nest Commander. Derived from
 * COMMAND_REGISTRY's `migrated` flag — see that file's header comment.
 */
export const MIGRATED_COMMAND_NAMES: readonly string[] = migratedCommandNames();
