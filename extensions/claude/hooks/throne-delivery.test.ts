import { expect, mock, test } from 'claude-code/testing'

const PANE = 'w1:p2'
const SOCKET = '/run/d.sock'
const RUNTIME = '/court/bin/throne-runtime'
const HELPER = '/court/extensions/claude/delivery-helper.ts'

type Child = { argv: readonly string[]; say: (line: object) => void; sayRaw: (text: string) => void; end: () => void }

function world(on: any, draft = '', dropped: string[] = []) {
  const submitted: string[] = []
  const reports: { socketPath: string; url: string; body: Record<string, unknown> }[] = []
  const commands: { command: string; args?: string }[] = []
  const children: Child[] = []
  const box = { text: draft, cursor: draft.length }
  mock.env(on, { HERDR_PANE_ID: PANE, THRONE_DELIVERY_SOCKET: SOCKET, THRONE_DELIVERY_RUNTIME: RUNTIME, THRONE_DELIVERY_HELPER: HELPER })
  const clock = mock.clock(on)
  on('process.spawn', async function* (_: unknown, e: any) {
    const pieces: (string | null)[] = []
    let wake = () => {}
    const push = (piece: string | null) => { pieces.push(piece); wake() }
    children.push({ argv: e.argv, say: line => push(`${JSON.stringify(line)}\n`), sayRaw: push, end: () => push(null) })
    for (;;) {
      while (pieces.length === 0) await new Promise<void>(resolve => { wake = resolve })
      const piece = pieces.shift()!
      if (piece === null) return { value: { code: 0, signal: null } }
      yield { stream: 'stdout', text: piece }
    }
  })
  on('http.fetch', (_: unknown, e: any) => {
    reports.push({ socketPath: e.init.socketPath, url: e.url, body: JSON.parse(e.init.body) })
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  on('command.run', (_: unknown, e: any) => { commands.push({ command: e.command, args: e.args }); return { value: {} } })
  on('prompt.read', () => ({ value: box }))
  on('prompt.submit', (_: unknown, e: any) => {
    if (dropped.includes(e.text)) return { drop: 'refused' }
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const settle = () => clock.advance(1)
  const listeningChild = async () => {
    await settle()
    const child = children.at(-1)!
    child.say({ listening: true })
    await settle()
    return child
  }
  return { submitted, reports, commands, children, box, clock, settle, listeningChild }
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('the mod starts the helper with THRONE_DELIVERY_RUNTIME and THRONE_DELIVERY_HELPER as its argument', async ($, on) => {
  const w = world(on)
  await start($)
  await w.settle()
  expect(w.children.map(child => child.argv)).toEqual([[RUNTIME, HELPER]])
})

test('a message is reported delivered only after prompt submit resolves with no drop', async ($, on) => {
  const w = world(on)
  await start($)
  const child = await w.listeningChild()
  const text = 'Alpha said: "hi" \\ 🎉\nline two'
  child.sayRaw(JSON.stringify({ id: 'message-1', text }).slice(0, 10))
  await w.settle()
  expect(w.reports).toEqual([])
  child.sayRaw(`${JSON.stringify({ id: 'message-1', text }).slice(10)}\n`)
  await w.settle()
  expect(w.submitted).toEqual([text])
  expect(w.reports).toEqual([{ socketPath: SOCKET, url: 'http://helper/result', body: { id: 'message-1', status: 'delivered', as: 'turn' } }])
})

test('a draft in the Claude box is left in the box when a message is submitted', async ($, on) => {
  const w = world(on, 'half typed')
  await start($)
  const child = await w.listeningChild()
  child.say({ id: 'message-2', text: 'do not wait for me' })
  await w.settle()
  expect(w.submitted).toEqual(['do not wait for me'])
  expect(w.box.text).toBe('half typed')
  expect(w.reports.map(report => report.body)).toEqual([{ id: 'message-2', status: 'delivered', as: 'turn' }])
})

test('a Claude agent in the middle of a turn submits the message at once', async ($, on) => {
  const w = world(on)
  await start($)
  const child = await w.listeningChild()
  await $.turn.start({ text: 'hold', turnId: 't1' })
  child.say({ id: 'message-3', text: 'queued behind the turn' })
  await w.settle()
  expect(w.submitted).toEqual(['queued behind the turn'])
  expect(w.reports.map(report => report.body)).toEqual([{ id: 'message-3', status: 'delivered', as: 'turn' }])
})

test('a dropped submit is reported refused and the next message is taken', async ($, on) => {
  const w = world(on, '', ['never entered'])
  await start($)
  const child = await w.listeningChild()
  child.say({ id: 'message-4', text: 'never entered' })
  child.say({ id: 'message-5', text: 'the next message' })
  await w.settle()
  expect(w.submitted).toEqual(['the next message'])
  expect(w.reports.map(report => report.body.status)).toEqual(['refused', 'delivered'])
})

test('commands run via command run as the mod commands made them and are reported delivered', async ($, on) => {
  const w = world(on)
  await start($)
  const child = await w.listeningChild()
  child.say({ id: 'command-a', command: 'color', args: 'green' })
  child.say({ id: 'command-b', command: 'rename', args: 'shadow-one' })
  await w.settle()
  expect(w.submitted).toEqual([])
  expect(w.commands).toEqual([{ command: 'color', args: 'green' }, { command: 'rename', args: 'shadow-one' }])
  expect(w.reports.map(report => report.body)).toEqual([
    { id: 'command-a', status: 'delivered', as: 'turn' },
    { id: 'command-b', status: 'delivered', as: 'turn' },
  ])
})

test('a command during a turn is reported turn-running and $.command.run is not called', async ($, on) => {
  const w = world(on)
  await start($)
  const child = await w.listeningChild()
  await $.turn.start({ text: 'hold', turnId: 't2' })
  child.say({ id: 'command-c', command: 'color', args: 'purple' })
  await w.settle()
  expect(w.commands).toEqual([])
  expect(w.reports.map(report => report.body)).toEqual([{ id: 'command-c', status: 'not-yet', reason: 'turn-running' }])
})

test('the same id asked twice runs once', async ($, on) => {
  const w = world(on)
  await start($)
  const child = await w.listeningChild()
  child.say({ id: 'command-d', command: 'color', args: 'purple' })
  child.say({ id: 'command-d', command: 'color', args: 'purple' })
  child.say({ id: 'message-7', text: 'once only' })
  child.say({ id: 'message-7', text: 'once only' })
  await w.settle()
  expect(w.commands).toEqual([{ command: 'color', args: 'purple' }])
  expect(w.submitted).toEqual(['once only'])
  expect(w.reports.map(report => report.body)).toEqual([
    { id: 'command-d', status: 'delivered', as: 'turn' },
    { id: 'command-d', status: 'delivered', as: 'turn' },
    { id: 'message-7', status: 'delivered', as: 'turn' },
    { id: 'message-7', status: 'delivered', as: 'turn' },
  ])
})

test('a withdrawn line submits nothing and reports nothing', async ($, on) => {
  const w = world(on)
  await start($)
  const child = await w.listeningChild()
  child.say({ withdrawn: 'message-6' })
  await w.settle()
  expect(w.submitted).toEqual([])
  expect(w.reports).toEqual([])
})

test('the mod restarts the helper when it has not reported listening within 5000 ms', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(4999)
  expect(w.children.length).toBe(1)
  await w.clock.advance(1002)
  await w.settle()
  expect(w.children.length).toBe(2)
})

test('the mod restarts the helper whenever it is gone', async ($, on) => {
  const w = world(on)
  await start($)
  const first = await w.listeningChild()
  first.end()
  await w.clock.advance(1001)
  await w.settle()
  expect(w.children.map(child => child.argv)).toEqual([[RUNTIME, HELPER], [RUNTIME, HELPER]])
})

test('a helper that exits at once is restarted only after a pause of one second', async ($, on) => {
  const w = world(on)
  await start($)
  await w.settle()
  w.children.at(-1)!.end()
  await w.clock.advance(999)
  expect(w.children.length).toBe(1)
  await w.clock.advance(2)
  await w.settle()
  expect(w.children.length).toBe(2)
  w.children.at(-1)!.end()
  await w.clock.advance(999)
  expect(w.children.length).toBe(2)
})
