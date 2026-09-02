REGENT — review-loop reviewer spawn request from {{LOOP_ALPHA}}.

Round: {{ROUND_LABEL}}
Target repo: {{TARGET_REPO}}
Reviewer model: {{REVIEWER_MODEL}}, effort {{REVIEWER_EFFORT}}
Requested spawn shape: {{SPAWN_SHAPE}}

I am not spawning this myself — role-pool admission is a hard gate outside
the steering engine, and per the Lord's direct ruling I carry no
--bypass-preset-agent / --bypass-effort / --bypass-alpha-guardrail
authority. Please spawn the reviewer with supervisor set to me
({{LOOP_ALPHA}}), read-only against {{TARGET_REPO}}, and hand it the round
prompt below.

## Delivered-contract context bundle

{{CONTEXT_BUNDLE}}

## Prior round's fix outcome

{{PRIOR_FIX_OUTCOME}}

If this spawn is refused, I will report the refusal and ask again or
escalate — I will not look for a flag that routes around it.
