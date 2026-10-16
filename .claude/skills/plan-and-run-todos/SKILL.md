---
name: plan-and-run-todos
description: Alias for /write-and-execute-todos — plan a todo bundle then immediately execute it end-to-end. Invoke via /plan-and-run-todos.
version: 0.1.0
user-invocable: true
disable-model-invocation: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension plan-and-run-todos` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Alias: /plan-and-run-todos → write-and-execute-todos

This is a thin alias. Immediately invoke the `write-and-execute-todos` skill and
follow its instructions exactly. Do not duplicate any logic here —
`write-and-execute-todos/SKILL.md` is the single source of truth.
