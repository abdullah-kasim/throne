# Notifications and bots
Summary: Sends messages to the Lord through ntfy and through Matrix bots.
Code: src/notify-lord, src/throne-bot
Search words: notify-lord, throne-bot-say, throne-bot-send-file, throne-bot-register-bot, throne-bot-list-bots, throne-bot-lint-objective, ntfy, matrix

## What it does

`notify-lord` sends one explicit message through the configured ntfy transport. The throne-bot commands register Matrix bots and rooms, list them, post text or files into a room, and lint a bot-filed objective for its final DONE step.

## Sub-features

- NT-NTFY: A disabled ntfy switch sends nothing.
- NT-BOT: Bots post text and files to their own room.
- NT-LINT: An objective without the final DONE step fails the lint.

## How to reach it and prove it works

```
bun test ./src/throne-bot/lint-objective.test.ts
```

## Gotchas

Bot commands need the homeserver running.
