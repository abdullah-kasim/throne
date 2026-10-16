---
name: pr-review-feedback
description: Alias for /pr-address-feedback — answer the review comments on a pull request. Trigger on /pr-review-feedback. Throne-only.
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension pr-review-feedback` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Alias: `/pr-review-feedback` → `/pr-address-feedback`

Invoke the `pr-address-feedback` skill immediately, pass the arguments through
unchanged, and follow it exactly. Do not duplicate any of its rules here.
