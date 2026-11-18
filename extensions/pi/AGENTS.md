# Instructions for every pi agent throne starts

## Read the global instructions first

Before doing anything else, read `~/.claude/CLAUDE.md` in full and follow it, together with every document it tells you to read. It is the global instruction file for every coding agent on this machine, whatever harness runs it. Where it says "Claude", it means you. If the file does not exist, say so once and carry on.

## Read both project files

When the working folder has both an `AGENTS.md` and a `CLAUDE.md`, read both. Pi loads only one of them by itself, so read the other one yourself.

## Searching the web

To search the web, use the agent-browser skill (`/skill:agent-browser`) with your own copy of the persistent `web-search` profile, and search on DuckDuckGo.

1. If you have not used agent-browser in this session, load its guide first: the `agent-browser` skill, or `agent-browser skills get core`, which prints the same guide.
2. Your agent name is in the `THRONE_AGENT_NAME` environment variable (`echo "$THRONE_AGENT_NAME"`). Below, `<name>` means that value.
3. The base profile is the folder `~/.agent-browser/profiles/web-search`. Create it if it does not exist: `mkdir -p ~/.agent-browser/profiles/web-search`. It is kept on purpose; never delete it, never search from it directly, and never use a throwaway profile for a web search.
4. You search from your own copy, `~/.agent-browser/profiles/web-search-<name>`. Before your first search, if that folder does not exist, copy the base into it, leaving out the top-level entries whose names start with `Singleton`:

   ```bash
   mkdir -p ~/.agent-browser/profiles/web-search-<name>
   find ~/.agent-browser/profiles/web-search -mindepth 1 -maxdepth 1 ! -name 'Singleton*' -exec cp -a {} ~/.agent-browser/profiles/web-search-<name>/ \;
   ```

   Keep using that copy for every later search. Copy nothing back into the base.
5. Open the search, with the words of your query joined by `+`:

   ```bash
   agent-browser --session web-search-<name> --profile ~/.agent-browser/profiles/web-search-<name> open "https://duckduckgo.com/?q=your+search+words"
   ```

   If DuckDuckGo shows a bot check instead of results, do not try to solve it and do not search on another site. Close the session, then open the same search again with `--headed` added, on the same session name and the same profile copy:

   ```bash
   agent-browser --session web-search-<name> close
   agent-browser --headed --session web-search-<name> --profile ~/.agent-browser/profiles/web-search-<name> open "https://duckduckgo.com/?q=your+search+words"
   ```

6. Read the results with `agent-browser --session web-search-<name> snapshot -i`, open the pages you need in the same session, and read them there.
7. When you are done, run `agent-browser --session web-search-<name> close`. Your copy stays.

Every agent has its own copy, so you never wait for another agent to finish searching.

Do not use any other search engine or web-search tool unless the user asks for it.

## Throne hooks on pi

The throne's hooks are listed once, in `claude-hooks/hooks.json` of the throne checkout. Throne installs `throne-pi-hooks.ts` into your extensions folder, and it runs the Python script of every entry whose `notOn` does not name `pi`: `PreToolUse` on each tool call, `PostToolUse` on each tool result, `SessionStart` and `SessionEnd` at the start and end of your session. A script sees `THRONE_HOOK_HARNESS=pi` in its environment. A refusal from a script blocks the call with its reason, and extra context from a script is added to the tool result.

An entry whose event pi does not have, a missing script, a crashing script, or an unreadable `hooks.json` writes one line to `pi-hook-bridge.log` in your data folder and never blocks a call. A pi agent that was already running gets the hooks only after it is relaunched, which `/restart-harnesses` does.
