import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const PAGE_FILE = resolve(import.meta.dirname, '..', '.claude/skills/where-i-stand/page/index.html');

const SCRIPT_ELEMENT = /<script(?:\s+src="([^"]*)")?>([\s\S]*?)<\/script>/g;

export async function pageScriptsInOrder(): Promise<string[]> {
  const page = await readFile(PAGE_FILE, 'utf8');
  return Promise.all(
    [...page.matchAll(SCRIPT_ELEMENT)].map(([, source, inlineScript]) =>
      source === undefined ? inlineScript : readFile(resolve(dirname(PAGE_FILE), source), 'utf8'),
    ),
  );
}

export class PageText {
  readonly nodeName = '#text';
  parentNode: PageElement | null = null;

  constructor(public textContent: string) {}
}

type PageNode = PageElement | PageText;

export class PageElement {
  readonly tagName: string;
  readonly nodeName: string;
  childNodes: PageNode[] = [];
  parentNode: PageElement | null = null;
  hidden = false;
  open?: boolean;
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
  };
  private readonly attributes = new Map<string, string>();

  constructor(
    tagName: string,
    private readonly browser: { activeElement: PageElement | null } = { activeElement: null },
  ) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      const child = node instanceof PageElement || node instanceof PageText ? node : new PageText(String(node));
      if (child.parentNode !== null) child.parentNode.childNodes = child.parentNode.childNodes.filter((sibling) => sibling !== child);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  replaceChildren(...nodes: unknown[]): void {
    this.childNodes = [];
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(text: string) {
    this.replaceChildren(text);
  }

  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    if (selector.startsWith('[')) return this.attributes.has(selector.slice(1, -1));
    return this.tagName === selector.toUpperCase();
  }

  closest(selector: string): PageElement | null {
    return this.matches(selector) ? this : (this.parentNode?.closest(selector) ?? null);
  }

  focus(): void {
    this.browser.activeElement = this;
  }

  elementChildren(): PageElement[] {
    return this.childNodes.filter((node): node is PageElement => node instanceof PageElement);
  }

  find(selector: string): PageElement[] {
    return this.elementChildren().flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.find(selector)]);
  }
}
