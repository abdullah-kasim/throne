import type { Engine, Register, SpawnEnd, SpawnPiece } from './claude-code-2.1.322.d.ts'

export const MIRRORED_CONTRACT = {
  resultPath: '/result',
  helperListenTimeoutMilliseconds: 5000,
  rememberedStartedIds: 500,
}

type Helper = { socket: string; runtime: string; script: string }

type TurnState = { turnRunning: boolean; started: Map<string, Report | undefined> }

type HelperLine = { id?: unknown; text?: unknown; command?: unknown; args?: unknown; listening?: unknown }

type Report = { status: 'delivered'; as: 'turn' } | { status: 'not-yet'; reason: string } | { status: 'refused'; detail: string }

function rememberStarted(state: TurnState, id: string, report?: Report) {
  state.started.delete(id)
  state.started.set(id, report)
  while (state.started.size > MIRRORED_CONTRACT.rememberedStartedIds) state.started.delete(state.started.keys().next().value as string)
}

async function submitMessage($: Engine, id: string, text: string, state: TurnState): Promise<Report> {
  rememberStarted(state, id)
  const submitted = await $.prompt.submit({ text }).catch((error: unknown) => ({ drop: String(error) }))
  if (submitted.drop === undefined) return { status: 'delivered', as: 'turn' }
  return { status: 'refused', detail: `submit dropped: ${String(submitted.drop)}` }
}

async function runCommand($: Engine, id: string, command: string, args: unknown, state: TurnState): Promise<Report> {
  if (state.turnRunning) return { status: 'not-yet', reason: 'turn-running' }
  rememberStarted(state, id)
  const failure = await $.command
    .run({ command, args: typeof args === 'string' ? args : undefined })
    .then(() => undefined, (error: unknown) => String(error))
  return failure === undefined ? { status: 'delivered', as: 'turn' } : { status: 'refused', detail: failure }
}

async function answerLine($: Engine, helper: Helper, line: HelperLine, state: TurnState) {
  if (typeof line.id !== 'string') return
  let report: Report | undefined
  if (state.started.has(line.id)) report = state.started.get(line.id)
  else if (typeof line.command === 'string') report = await runCommand($, line.id, line.command, line.args, state)
  else if (typeof line.text === 'string') report = await submitMessage($, line.id, line.text, state)
  if (report === undefined) return
  if (report.status !== 'not-yet' && state.started.has(line.id)) rememberStarted(state, line.id, report)
  await $.http
    .fetch(`http://helper${MIRRORED_CONTRACT.resultPath}`, { method: 'POST', body: JSON.stringify({ id: line.id, ...report }), socketPath: helper.socket })
    .catch(() => undefined)
}

const LATE = Symbol('late')

export const HELPER_RESTART_PAUSE_MILLISECONDS = 1000

async function runHelperOnce($: Engine, helper: Helper, state: TurnState) {
  const child = $.process.spawn({ argv: [helper.runtime, helper.script] })
  let listening = false
  let buffered = ''
  const listenDeadline = $.clock.sleep(MIRRORED_CONTRACT.helperListenTimeoutMilliseconds).then(() => LATE)
  for (;;) {
    const piece: IteratorResult<SpawnPiece, SpawnEnd> | typeof LATE = listening
      ? await child.next()
      : await Promise.race([child.next(), listenDeadline])
    if (piece === LATE) {
      void child.return({ code: null, signal: null })
      return
    }
    if (piece.done) return
    if (piece.value.stream !== 'stdout') continue
    buffered += piece.value.text
    let end = buffered.indexOf('\n')
    while (end !== -1) {
      const text = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      end = buffered.indexOf('\n')
      let line: HelperLine
      try {
        line = JSON.parse(text)
      } catch {
        continue
      }
      if (line.listening === true) listening = true
      else void answerLine($, helper, line, state).catch(() => undefined)
    }
  }
}

async function keepHelperRunning($: Engine, helper: Helper, state: TurnState) {
  for (;;) {
    await runHelperOnce($, helper, state).catch(() => undefined)
    await $.clock.sleep(HELPER_RESTART_PAUSE_MILLISECONDS)
  }
}

export const register: Register = on => {
  let started = false
  const state: TurnState = { turnRunning: false, started: new Map() }

  on('turn.start', ($, e, next) => { if (!e.agentId) state.turnRunning = true; return next(e) })
  on('turn.complete', ($, e, next) => { if (!e.agentId) state.turnRunning = false; return next(e) })

  on('session.start', async ($, e, next) => {
    if (started) return next(e)
    started = true
    const helper = {
      socket: (await $.env.get('THRONE_DELIVERY_SOCKET'))?.trim() ?? '',
      runtime: (await $.env.get('THRONE_DELIVERY_RUNTIME'))?.trim() ?? '',
      script: (await $.env.get('THRONE_DELIVERY_HELPER'))?.trim() ?? '',
    }
    if (helper.socket && helper.runtime && helper.script) void keepHelperRunning($, helper, state).catch(() => undefined)
    return next(e)
  })
}
