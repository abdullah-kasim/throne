# Runtime ownership map

The Nest owners are responsibility-centered services; closed responsibilities
are implemented directly under the Nest owner.

| Responsibility | Nest owner | Platform/config/transport seam |
| --- | --- | --- |
| Feature-flag reads | `FeatureFlagsService` | `loadFeatureFlags` / injected reader |
| Persona configuration | `ApplicationConfigService` | `PERSONA_CONFIG` / injected config |
| Lord notifications | `NotificationService` | `postNtfyMessage` / injected transport |
| Unit rendering | `ServiceUnitRenderer` | `renderUnitSource` / injected consumers |
| Ledger data access | `LedgerDataService` | `agentdata/locations`, registration/completion/archive, `spawn`, `resumable-work` |
| Identity data access | `IdentityDataService` | `agentdata/identity-data.service` |
| Tree-base data access | `TreeBaseDataService` | `agentdata/tree-base` |

`install-services/platform.ts` consumes `FeatureFlagsService`; the
`notify-lord` command consumes `NotificationService` and
`ApplicationConfigService`. The three agent-data owners expose the existing
responsibility boundaries. Registry behavior is closed inside
`LedgerDataService`; no root is moved, copied, shimmed, or re-exported.
