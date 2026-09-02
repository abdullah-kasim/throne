export const HERDR_HELPER_JUSTIFICATIONS: Readonly<Record<string, string>> = {
  'herdr/herdr-claude.service.ts': 'Claude-specific pane interaction changes independently from generic Herdr lifecycle effects',
  'herdr/herdr-opencode.service.ts': 'OpenCode-specific pane interaction changes independently from generic Herdr lifecycle effects',
  'herdr/herdr-send.helpers.ts': 'shared send transport helpers change independently from submission orchestration',
  'herdr/herdr-send-keyed-window.ts': 'keyed delivery-window ownership/takeover/outcome-fanout changes independently from the unkeyed submission transaction',
  'herdr/herdr-send-transaction.ts': 'the per-harness locked submit transaction changes independently from claim/lock/staging orchestration',
  'herdr/herdr-runtime.service.ts':
    'registered recipient ownership proof, repair, and harness-process recognition change independently from generic Herdr inventory access',
  'herdr/herdr-screen.service.ts':
    'shared read-only pane observation avoids cycles and a mixed 700-plus-line send owner',
  'herdr/herdr-composer-deadline-message.ts':
    'the composer-deadline error wording per observed composer state changes independently from the composer observation/polling mechanics that detect the state',
  'herdr/herdr-composer-diagnostic-capture.ts':
    'forensic capture of the last-observed screen behind an unavailable-composer timeout changes independently from the polling mechanics that decide when to give up',
  'herdr/herdr-send.types.ts':
    'submission declarations would push the measured runtime owner above 500',
  'herdr/herdr-agent-recovery.ts':
    'restored/quarantined-agent race recovery changes independently from ordinary agent launch',
  'herdr/herdr-agent-registration-wait.ts':
    'the synchronous just-launched-pane registration poll changes independently from the delivery transaction that waits on it',
  'herdr/herdr-client.ts':
    'the raw herdr CLI invocation boundary changes independently from every higher-level owner that calls through it',
  'herdr/herdr-create.contracts.ts':
    'shared creation/resume type declarations change independently from the services that implement them',
  'herdr/herdr-create.service.ts':
    'interactive agent creation and restored-tab resume orchestration change independently from generic Herdr inventory access',
  'herdr/herdr-creation-orchestration.ts':
    'the top-level start-agent orchestration sequence changes independently from the launch/readiness primitives it composes',
  'herdr/herdr-errors.ts':
    'the named agent-start/opening-prompt error taxonomy changes independently from the services that throw it',
  'herdr/herdr-harness.service.ts':
    'per-harness composer dispatch changes independently from the individual claude/codex/opencode services it routes between',
  'herdr/herdr-identity-contracts.ts':
    'agent-identity shape and name-matching rules change independently from the services that resolve identity',
  'herdr/herdr-identity.service.ts':
    'agent-name validation policy changes independently from the identity contracts it validates against',
  'herdr/herdr-inventory.service.ts':
    'herdr CLI output parsing into typed inventory records changes independently from the client that issues the commands',
  'herdr/herdr-launch-command.ts':
    'per-harness launch-argv and detection-timeout policy changes independently from the generic start-in-tab sequencing',
  'herdr/herdr-launch-context.ts':
    'caller-context collection and start-failure annotation change independently from the launch sequence they describe',
  'herdr/herdr-launch.ts':
    'the shell-readiness-gated start-in-tab sequence changes independently from the per-harness launch-command policy it invokes',
  'herdr/herdr-opening-prompt.ts':
    'first-turn opening-prompt delivery changes independently from the generic submission transaction it reuses',
  'herdr/herdr-process-detection.ts':
    'process/executable-name recognition changes independently from the inventory records it classifies',
  'herdr/herdr-readiness.ts':
    'shell-readiness polling changes independently from the tab lifecycle that waits on it',
  'herdr/herdr-restored-tab-cleanup.ts':
    'stray-pane cleanup after a restored-tab takeover changes independently from the resume deps it consumes',
  'herdr/herdr-restored-tab-inspection.ts':
    'restored-tab ownership inspection changes independently from ordinary agent creation',
  'herdr/herdr-send-enter-until-empty.ts':
    'the bounded Enter-until-empty submission loop changes independently from the send transaction that calls it',
  'herdr/herdr-session-presence.ts':
    'session-presence detection changes independently from the read-only client it wraps',
  'herdr/herdr-session.service.ts':
    'current-session/pane-id resolution changes independently from generic Herdr inventory access',
  'herdr/herdr-tab.service.ts':
    'tab lifecycle (create/close/rename) changes independently from generic Herdr inventory access',
  'herdr/keyed-submission-token.ts':
    'the on-disk keyed delivery-window token store changes independently from the submission transaction that consults it',
  'herdr/herdr-send-test-fixtures.ts':
    'shared fake-agent test fixtures change independently from the submission implementation they exercise',
  'herdr/herdr-send-unkeyed.ts':
    'the unkeyed submission fallback path changes independently from the keyed delivery-window transaction',
};

export const HERDR_PUBLIC_SURFACE: readonly string[] = [
  'AGENT_DETECTION_POLL_MS', 'AGENT_DETECTION_TIMEOUT_MS', 'AGENT_START_BUSY_MAX_ATTEMPTS',
  'AGENT_START_BUSY_RETRY_DELAY_MS', 'AGENT_STATUSES', 'AgentDetectionTimeoutError', 'AgentResolutionError',
  'AgentStartEvidence', 'AgentStartIndeterminateError', 'AgentStartPaneBusyError', 'AgentStatus',
  'CODEX_HERDR_READ_TIMEOUT_MS',
  'HERDR_PROMPT_SETTLED_TIMEOUT_MS',
  'CreatedTab', 'DeliverOpeningPromptDeps', 'HerdrAgent', 'HerdrAttachBoundary',
  'HerdrCommandError', 'HerdrCompatibilityError', 'HerdrForegroundProcess', 'HerdrNameOwner', 'HerdrPane',
  'HerdrPaneProcessInfo', 'HerdrProcessBoundary', 'HerdrRuntimeMode', 'HerdrTab',
  'OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS',
  'OPENING_PROMPT_NAME_REGISTRATION_POLL_MILLISECONDS', 'OpeningPromptDeliveryError',
  'PaneReadinessTimeoutError', 'RESTORED_TAB_RACE_RECHECK_ATTEMPTS', 'RESTORED_TAB_RACE_RECHECK_MS',
  'ReadOptions', 'ReadSource', 'RegisteredAgentRestoredTabCollisionError',
  'ResumeRegisteredAgentInRestoredTabDeps', 'ResumeRegisteredAgentInRestoredTabResult',
  'SHELL_READY_CAPTURE_LINES', 'SHELL_READY_PROBE_COMMAND_MARKER',
  'SHELL_READY_PROBE_WINDOW_MS', 'SHELL_READY_TIMEOUT_MS', 'START_CONTEXT_ENV_ALLOWLIST',
  'START_EVIDENCE_PHASES', 'ShellReadyEvidence', 'StartCallerContext', 'StartCallerContextDeps', 'StartEvidencePhase',
  'StartFailureAnnotation', 'StartFailureOwnership', 'StartInTabDeps', 'StartOptions',
  'SubmitAssumedFilledError', 'SubmitNotSentError', 'SubmitToAgentDeps', 'SubmitToAgentOptions',
  'SupportedScreenObservationDeps',
  'THRONE_HERDR_PROTOCOL', 'THRONE_HERDR_SESSION', 'agentStatusAcceptsInput', 'annotateStartFailure',
  'attachThroneHerdr', 'captureProvesExecutedSentinel',
  'closeAgentTab', 'closePane', 'closeTab', 'codexTextboxClearance',
  'collectStartCallerContext',
  'createTab', 'currentPaneId', 'deliverOpeningPrompt', 'getPaneProcessInfo', 'insideHerdr',
  'isIndeterminateAgentStartError', 'isLiveHarnessProcess',
  'isTransientComposerObservationFailure', 'isTransientPaneBusyStartError', 'listAgents', 'listNameOwners',
  'listPanes', 'listTabs', 'paneHasLiveHarnessProcess', 'paneOutputBytes', 'parseAgentList',
  'parseHerdrErrorCode', 'parseNameOwners', 'parsePaneList', 'parsePaneProcessInfo', 'parseReadText',
  'parseTabList', 'preflightHerdrCompatibility', 'pressEnter', 'pressPaneKey', 'readAgent', 'readAgentStatus',
  'readRecentAgentAnsi', 'readRecentCodexAgentAnsi', 'readStartFailureAnnotation', 'readVisibleAgentAnsi',
  'REAL_ENTER_UNTIL_EMPTY_DEPS',
  'readVisibleAgentText', 'readVisibleCodexAgentAnsi', 'renameAgent',
  'renameTab', 'resolveAgent', 'resolveCurrentAgentName', 'restoredAgentQuarantineName',
  'resumeRegisteredAgentInRestoredTab', 'runHerdr', 'sameAgentName', 'sendText',
  'startAgent', 'startInTab', 'submitToAgent', 'submitToAgentWhileLocked',
  'waitForShellReady',
];
