# pi agent look
Summary: Gives a pi agent Claude Code's /rename and /color, draws its editor borders in the agent's colour and puts its session name in a solid badge at the right end of the top border.
Code: extensions/pi/throne-pi-agent-look.ts
Search words: pi look, /rename, /color, rename, color, colour, badge, border, throne-agent-colour, throne:agent-setting, CustomEditor

## What it does

`extensions/pi/throne-pi-agent-look.ts` is installed by the throne pi state extension (`extensions/pi/throne-pi-state.ts`) into every throne-launched pi agent. It registers two pi commands. `/rename <name>` calls pi's `setSessionName`, so pi's `/name` and footer show the name; a bare `/rename` is refused. `/color <colour>` takes exactly the colour names Claude Code's `/color` takes: red, blue, green, yellow, purple, orange, pink, cyan. `default`, `reset`, `none`, `gray` and `grey` clear it, a bare `/color` picks one at random, and any other word is refused with a notice listing the options. A set or cleared colour is stored as a custom session entry `throne-agent-colour` `{ colour }` (`default` when cleared); the newest entry wins, and it is read back at `session_start`, so the colour survives a restart or resume.

The same apply step takes `pi.events.emit("throne:agent-setting", { command: "color" | "rename", args })`, which is how the pi delivery extension hands on a command request from throne (MSG-PI, BE-SETTINGS).

The editor is a `CustomEditor` subclass with pi's working spinner and keybindings left as they are. When another extension already configured an editor, that editor's instance is kept and moved onto the subclass built over its own class, so it is wrapped rather than replaced. With a colour set, both border lines are drawn in that colour (Claude Code's dark-theme truecolor value for it), and the top line's last rule characters are replaced by ` <session name> ` in black text on that colour, followed by one rule character. With no colour, the borders keep the colour pi gives them and the badge sits on the theme accent. With no session name, no badge is drawn.

## Sub-features

- LOOK-RENAME: `/rename <name>` sets pi's session name; a bare `/rename` is refused.
- LOOK-COLOR: `/color` accepts exactly Claude Code's colour names, clears on `default`, `reset`, `none`, `gray` or `grey`, picks at random when bare, refuses anything else, and the colour survives a restart or resume.
- LOOK-BORDERS: A set colour draws both editor border lines and a solid name badge at the right of the top border in that colour; no colour keeps pi's border colour with an accent badge; the spinner and keys are kept and an editor configured earlier is wrapped.
- LOOK-EVENT: A `throne:agent-setting` event applies a colour or name through the same step as the commands.

## How to reach it and prove it works

In a throne-launched pi pane, type `/color green` and `/rename scout`: both borders turn green and a green `scout` badge appears at the right end of the top border; after restarting the session the colour is still green.

```
bun test ./extensions/pi/throne-pi-agent-look.spec.ts
```

Exits 0.

## Gotchas

The badge replaces trailing rule characters of the top border; a top line that does not end in enough of them is drawn without a badge. A pi agent launched before this extension keeps pi's plain look until it is relaunched. throne's pi composer reader treats a border line holding the badge as a border (`src/codex-screen/composer/pi-composer.ts`), so messages still reach a pi pane whose name is drawn there.
