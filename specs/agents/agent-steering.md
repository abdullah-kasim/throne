# Model and persona switching
Summary: Moves a live agent to another model of the same family, or switches the court persona.
Code: src/switch-agent-model, src/switch-persona
Search words: switch-agent-model, switch-persona, persona

## What it does

`switch-agent-model` resumes a registered live agent exactly where it was under another model of the same family. `switch-persona` shows, lists or switches the roleplay persona preset and syncs the ledger's addressing links without renaming live agents.

## Sub-features

- SW-MODEL: A model switch keeps the native session.
- SW-PERSONA: Switching persona never renames a live agent.

## How to reach it and prove it works

Run `throne switch-persona` with its list form; the presets are printed and the current one is marked. A model switch is proven by running it on a scratch agent and seeing the same session resume.

## Gotchas

Crossing model families is refused.
