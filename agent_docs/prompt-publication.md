# Agent prompt publication

Every throne-controlled line published into an agent prompt names its actor and
scope, or it does not enter prompt context. Session-start hook narration must
self-identify because it has no sender envelope. Opening prompts address the
named agent and identify its identity, chain of command, and assignment scope.
Queued notices and nudges use the shared `<sender> said: <message>` envelope;
their message body states the work or observation that sender is addressing.

Quoted authority remains authoritative. Agents must not guess that a
higher-ranking instruction cancels published text: the publisher is responsible
for saying who speaks, what is affected, and what is outside the statement's
scope.

Absence claims list every surface searched. In particular, searching `.claude/`
alone cannot disprove prompt-visible runtime output: evidence must also cover
SessionStart command stdout, generated opening prompts, assignment delivery,
queued keep-going/no-idling notices, and every other direct agent-submit owner.
