export type PromptBox = { text: string; cursor: number }

export type SpawnPiece = { stream: 'stdout' | 'stderr'; text: string }

export type SpawnEnd = { code: number | null; signal: string | null }

export type Engine = {
  env: { get: (name: string) => Promise<string | undefined> }
  prompt: {
    read: () => Promise<PromptBox>
    submit: (input: { text: string }) => Promise<{ drop?: unknown }>
  }
  command: { run: (input: { command: string; args?: string }) => Promise<{ text?: string; context?: readonly string[] }> }
  clock: { sleep: (ms: number) => Promise<void> }
  process: { spawn: (request: { argv: readonly string[] }) => AsyncGenerator<SpawnPiece, SpawnEnd> }
  http: { fetch: (url: string, init: { method: string; body: string; socketPath: string }) => Promise<{ status: number }> }
}

export type Next<Event> = (e: Event) => unknown

export type TurnEvent = { turnId: string; agentId?: string }

export type Hook<Event> = ($: Engine, e: Event, next: Next<Event>) => unknown

export type On = {
  (event: 'session.start', hook: Hook<{ cwd: string }>): void
  (event: 'turn.start' | 'turn.complete', hook: Hook<TurnEvent>): void
}

export type Register = (on: On) => void
