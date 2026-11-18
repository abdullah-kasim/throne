import type { Engine, Register, SpawnEnd, SpawnPiece } from './claude-code-2.1.322.d.ts'

export const MIRRORED_CONTRACT = {
  resultPath: '/result',
  helperListenTimeoutMilliseconds: 5000,
}

type Helper = { socket: string; runtime: string; script: string }

type TurnState = { turnRunning: boolean }

type HelperLine = { id?: unknown; text?: unknown; command?: unknown; args?: unknown; listening?: unknown }

type Report = { status: 'delivered'; as: 'turn' } | { status: 'not-yet'; reason: string } | { status: 'refused'; detail: string }

async function submitMessage($: Engine, text: string, state: TurnState): Promise<Report> {
  if (state.turnRunning) return { status: 'not-yet', reason: 'turn-running' }
  const box = await $.prompt.read().catch(() => undefined)
  if (box === undefined) return { status: 'not-yet', reason: 'composer-unreadable' }
  if (box.text !== '') return { status: 'not-yet', reason: 'draft' }
  state.turnRunning = true
  const submitted = await $.prompt.submit({ text }).catch((error: unknown) => ({ drop: String(error) }))
  if (submitted.drop === undefined) return { status: 'delivered', as: 'turn' }
  state.turnRunning = false
  return { status: 'refused', detail: `submit dropped: ${String(submitted.drop)}` }
}

async function runCommand($: Engine, command: string, args: unknown): Promise<Report> {
  const failure = await $.command
    .run({ command, args: typeof args === 'string' ? args : undefined })
    .then(() => undefined, (error: unknown) => String(error))
  return failure === undefined ? { status: 'delivered', as: 'turn' } : { status: 'refused', detail: failure }
}

async function answerLine($: Engine, helper: Helper, line: HelperLine, state: TurnState) {
  if (typeof line.id !== 'string') return
  let report: Report
  if (typeof line.command === 'string') report = await runCommand($, line.command, line.args)
  else if (typeof line.text === 'string') report = await submitMessage($, line.text, state)
  else return
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
      else await answerLine($, helper, line, state)
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
  const state: TurnState = { turnRunning: false }

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
