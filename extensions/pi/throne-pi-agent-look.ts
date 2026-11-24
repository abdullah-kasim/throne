export const COLOUR_ENTRY_TYPE = "throne-agent-colour";
export const AGENT_SETTING_EVENT = "throne:agent-setting";
const NO_COLOUR = "default";
export const COLOUR_CLEARING_WORDS: readonly string[] = [NO_COLOUR, "reset", "none", "gray", "grey"];
const RESET = "\x1b[0m";
const DARK_TEXT = "\x1b[38;2;0;0;0m";
const RULE = "─";

export const CLAUDE_CODE_COLOURS: Readonly<Record<string, readonly [number, number, number]>> = {
  red: [220, 38, 38],
  blue: [106, 155, 204],
  green: [22, 163, 74],
  yellow: [202, 138, 4],
  purple: [130, 125, 189],
  orange: [217, 119, 87],
  pink: [196, 102, 134],
  cyan: [8, 145, 178],
};

export const CLAUDE_CODE_COLOUR_NAMES = Object.keys(CLAUDE_CODE_COLOURS);

type Painter = (text: string) => string;
type SessionEntry = { type?: string; customType?: string; data?: { colour?: unknown } };
type EditorFactory = (tui: any, theme: any, keybindings: any) => any;
export type AgentSettingCommand = { command: string; args: string };

function colourCode(colour: string, layer: 38 | 48): string {
  const [red, green, blue] = CLAUDE_CODE_COLOURS[colour];
  return `\x1b[${layer};2;${red};${green};${blue}m`;
}

function backgroundOf(foreground: string): string {
  return foreground.replace(/\x1b\[38;/g, "\x1b[48;");
}

export function colourOfSession(entries: readonly SessionEntry[]): string | undefined {
  let colour: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== COLOUR_ENTRY_TYPE) continue;
    const recorded = entry.data?.colour;
    if (typeof recorded === "string") colour = recorded in CLAUDE_CODE_COLOURS ? recorded : undefined;
  }
  return colour;
}

function withoutTrailingRules(line: string, count: number): string | undefined {
  const pieces = line.match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? [];
  let removed = 0;
  for (let index = pieces.length - 1; index >= 0 && removed < count; index--) {
    if (pieces[index].startsWith("\x1b")) continue;
    if (pieces[index] !== RULE) return undefined;
    pieces.splice(index, 1);
    removed++;
  }
  return removed === count ? pieces.join("") : undefined;
}

type EditorClass = new (tui: any, theme: any, keybindings: any, options?: any) => any;

export function installAgentLook(pi: any, loadCustomEditor: () => Promise<EditorClass>) {
  let colour: string | undefined;
  let tui: any;
  let ours: EditorFactory | undefined;
  let underneath: EditorFactory | undefined;
  const lookClasses = new Map<EditorClass, EditorClass>();
  const redraw = () => tui?.requestRender?.();

  const wearColour = (editor: any) => {
    let piBorder: Painter | undefined = editor.borderColor;
    Object.defineProperty(editor, "borderColor", {
      configurable: true,
      get: (): Painter | undefined => (colour === undefined ? piBorder : (text: string) => `${colourCode(colour!, 38)}${text}${RESET}`),
      set: (painter: Painter | undefined) => {
        piBorder = painter;
      },
    });
  };

  const withBadge = (editor: any, lines: string[]): string[] => {
    const label = pi.getSessionName();
    if (lines.length < 2 || !label) return lines;
    const badge = ` ${label} `;
    const background = colour === undefined ? backgroundOf(accent()) : colourCode(colour, 48);
    const top = withoutTrailingRules(lines[0], badge.length + 1);
    if (top === undefined) return lines;
    const border: Painter = editor.borderColor ?? ((text: string) => text);
    lines[0] = `${top}${background}${DARK_TEXT}${badge}${RESET}${border(RULE)}`;
    return lines;
  };

  let accent = () => "";

  const lookOf = (Base: EditorClass): EditorClass => {
    const known = lookClasses.get(Base);
    if (known) return known;
    class AgentColourEditor extends Base {
      constructor(...parts: any[]) {
        super(...(parts as [any, any, any, any?]));
        wearColour(this);
      }
      render(width: number): string[] {
        return withBadge(this, super.render(width));
      }
    }
    lookClasses.set(Base, AgentColourEditor);
    return AgentColourEditor;
  };

  const apply = ({ command, args }: AgentSettingCommand): { notice: string; refused: boolean } => {
    const value = args.trim();
    if (command === "rename") {
      if (value === "") return { notice: "Give the session a name: /rename <name>", refused: true };
      pi.setSessionName(value);
      redraw();
      return { notice: `Session renamed to: ${value}`, refused: false };
    }
    if (command !== "color") return { notice: `pi takes no /${command} from throne`, refused: true };
    const chosen = value === "" ? CLAUDE_CODE_COLOUR_NAMES[Math.floor(Math.random() * CLAUDE_CODE_COLOUR_NAMES.length)] : value.toLowerCase();
    const clears = COLOUR_CLEARING_WORDS.includes(chosen);
    if (!clears && !(chosen in CLAUDE_CODE_COLOURS)) {
      return { notice: `"${chosen}" isn't an available color. Options: ${CLAUDE_CODE_COLOUR_NAMES.join(", ")}, ${NO_COLOUR}`, refused: true };
    }
    pi.appendEntry(COLOUR_ENTRY_TYPE, { colour: clears ? NO_COLOUR : chosen });
    colour = clears ? undefined : chosen;
    redraw();
    return { notice: clears ? "Session color reset to default" : `Session color set to: ${chosen}`, refused: false };
  };

  for (const command of ["rename", "color"]) {
    pi.registerCommand(command, {
      description: command === "rename" ? "Name this session" : "Colour this agent's editor like Claude Code's /color",
      handler: async (args: string, context: any) => {
        const { notice, refused } = apply({ command, args });
        context?.ui?.notify?.(notice, refused ? "error" : "info");
      },
    });
  }
  pi.events?.on?.(AGENT_SETTING_EVENT, (data: any) => {
    if (typeof data?.command === "string" && typeof data?.args === "string") apply(data);
  });

  pi.on("session_start", async (_event: unknown, context: any) => {
    colour = colourOfSession(context.sessionManager.getBranch());
    if (!context.hasUI || !context.ui?.setEditorComponent) return;
    accent = () => context.ui.theme.getFgAnsi("accent");
    const configured = context.ui.getEditorComponent?.();
    if (configured !== ours || ours === undefined) underneath = configured;
    const inner = underneath;
    const CustomEditor = await loadCustomEditor();
    ours = (screen, theme, keybindings) => {
      tui = screen;
      if (inner === undefined) return new (lookOf(CustomEditor))(screen, theme, keybindings, { embedWorkingStatus: true });
      const editor = inner(screen, theme, keybindings);
      Object.setPrototypeOf(editor, lookOf(Object.getPrototypeOf(editor).constructor).prototype);
      wearColour(editor);
      return editor;
    };
    context.ui.setEditorComponent(ours);
  });

  return apply;
}
