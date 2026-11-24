import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_SETTING_EVENT, CLAUDE_CODE_COLOUR_NAMES, COLOUR_ENTRY_TYPE, installAgentLook } from "./throne-pi-agent-look.ts";

const GREEN = "\x1b[38;2;22;163;74m";
const GREEN_BACKGROUND = "\x1b[48;2;22;163;74m";
const PI_BORDER = "\x1b[38;5;60m";
const ACCENT = "\x1b[38;5;39m";

function fakePi(entries: any[] = []) {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const listeners = new Map<string, any>();
  const notices: string[] = [];
  let sessionName: string | undefined;
  const pi = {
    registerCommand: (name: string, options: any) => commands.set(name, options),
    on: (event: string, handler: any) => handlers.set(event, handler),
    events: { on: (channel: string, handler: any) => listeners.set(channel, handler), emit: (channel: string, data: unknown) => listeners.get(channel)?.(data) },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    setSessionName: (name: string) => {
      sessionName = name;
    },
    getSessionName: () => sessionName,
  };
  return { pi, commands, handlers, entries, notices, run: (name: string, args: string) => commands.get(name).handler(args, { ui: { notify: (text: string) => notices.push(text) } }) };
}

class FakeCustomEditor {
  borderColor: (text: string) => string = (text) => `${PI_BORDER}${text}\x1b[0m`;
  readonly embedWorkingStatus: boolean;
  constructor(_tui: unknown, _theme: unknown, _keybindings: unknown, options?: { embedWorkingStatus?: boolean }) {
    this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
  }
  render(width: number): string[] {
    const status = this.embedWorkingStatus ? "⠋ Working " : "";
    return [this.borderColor(`── ${status}${"─".repeat(width - 3 - status.length)}`), "draft", this.borderColor("─".repeat(width))];
  }
}

async function startedPane(fake: ReturnType<typeof fakePi>, configured?: (...parts: any[]) => any) {
  let factory: any = configured;
  const context = {
    hasUI: true,
    sessionManager: { getBranch: () => fake.entries },
    ui: { getEditorComponent: () => factory, setEditorComponent: (next: any) => (factory = next), theme: { getFgAnsi: () => ACCENT } },
  };
  await fake.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
  const editor = factory({ requestRender: () => undefined }, {}, {});
  editor.borderColor = (text: string) => `${PI_BORDER}${text}\x1b[0m`;
  return editor;
}

function newPane(entries: any[] = []) {
  const fake = fakePi(entries);
  installAgentLook(fake.pi, async () => FakeCustomEditor);
  return fake;
}

describe("a pi agent's name and colour", () => {
  it("renaming a pi session with /rename shows the name pi's /name reports", async () => {
    const pane = newPane();
    await pane.run("rename", "  night-baker ");
    assert.equal(pane.pi.getSessionName(), "night-baker");
  });

  it("a pi agent's colour set with /color comes back after the session is resumed", async () => {
    const first = newPane();
    await first.run("color", "Green");
    const resumed = newPane(first.entries);
    resumed.pi.setSessionName("night-baker");
    const [top] = (await startedPane(resumed)).render(40);
    assert.ok(top.includes(GREEN));
  });

  it("/color refuses a colour Claude Code does not offer", async () => {
    const pane = newPane();
    await pane.run("color", "teal");
    assert.equal(pane.entries.length, 0);
    assert.match(pane.notices[0], /"teal" isn't an available color\. Options: red, blue, green, yellow, purple, orange, pink, cyan, default/);
  });

  it("a coloured pi agent's editor borders and name badge are drawn in its colour", async () => {
    const pane = newPane();
    pane.pi.setSessionName("night-baker");
    const editor = await startedPane(pane);
    pane.pi.events.emit(AGENT_SETTING_EVENT, { command: "color", args: "green" });
    const lines = editor.render(40);
    assert.ok(lines[0].startsWith(GREEN));
    assert.ok(lines[0].includes("⠋ Working"));
    assert.ok(lines[0].includes(`${GREEN_BACKGROUND}\x1b[38;2;0;0;0m night-baker \x1b[0m`));
    assert.ok(lines.at(-1)!.startsWith(GREEN));
    assert.equal(lines[0].replace(/\x1b\[[0-9;]*m/g, "").length, 40);
  });

  it("a pi agent with no colour keeps pi's borders and shows its name in the accent colour", async () => {
    const pane = newPane();
    pane.pi.setSessionName("night-baker");
    const editor = await startedPane(pane);
    await pane.run("color", "green");
    await pane.run("color", "default");
    const lines = editor.render(40);
    assert.ok(lines[0].startsWith(PI_BORDER) && lines.at(-1)!.startsWith(PI_BORDER));
    assert.ok(lines[0].includes("\x1b[48;5;39m\x1b[38;2;0;0;0m night-baker "));
  });

  it("the pi agent look is drawn by a CustomEditor that keeps an editor already configured underneath", async () => {
    const pane = newPane();
    pane.pi.setSessionName("night-baker");
    const own = await startedPane(pane);
    assert.ok(own instanceof FakeCustomEditor);
    assert.equal(own.embedWorkingStatus, true);
    class OtherEditor extends FakeCustomEditor {
      submitted: string[] = [];
      handleInput(data: string) {
        this.submitted.push(data);
      }
    }
    const other = newPane();
    other.pi.setSessionName("night-baker");
    const wrapped = await startedPane(other, (tui: unknown, theme: unknown, keybindings: unknown) => new OtherEditor(tui, theme, keybindings));
    await other.run("color", "green");
    wrapped.handleInput("\r");
    assert.ok(wrapped instanceof OtherEditor);
    assert.deepEqual(wrapped.submitted, ["\r"]);
    const [top] = wrapped.render(40);
    assert.ok(top.startsWith(GREEN) && top.includes(" night-baker "));
  });

  it("/color with reset, none, gray or grey clears the colour as Claude Code does", async () => {
    for (const word of ["reset", "none", "gray", "Grey"]) {
      const pane = newPane();
      pane.pi.setSessionName("night-baker");
      const editor = await startedPane(pane);
      await pane.run("color", "green");
      await pane.run("color", word);
      assert.equal(pane.notices.at(-1), "Session color reset to default");
      assert.ok(editor.render(40)[0].startsWith(PI_BORDER));
      assert.deepEqual(pane.entries.at(-1).data, { colour: "default" });
    }
  });

  it("a bare /color picks one of Claude Code's colours", async () => {
    const pane = newPane();
    await pane.run("color", "  ");
    const entry = pane.entries.at(-1);
    assert.equal(entry.customType, COLOUR_ENTRY_TYPE);
    assert.ok(CLAUDE_CODE_COLOUR_NAMES.includes(entry.data.colour));
    assert.equal(pane.notices.at(-1), `Session color set to: ${entry.data.colour}`);
  });
});
