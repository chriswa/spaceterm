import { describe, it, expect, beforeEach } from 'vitest'
import { AutomationRunner, cronSlotsBetween, decideFiring, LATE_AFTER_MS, type AutomationHost, type RunPlacement } from './automation-runner'
import type { AutomationFiring, AutomationOverlap } from '../shared/automation'
import type { AutomationNodeData, NodeData, TerminalNodeData } from '../shared/state'
import { asNodeId, ROOT_NODE_ID, type NodeId } from '../shared/ids'

// Quarter-hour slots, so the tests hold in any time zone (every offset in use
// is a multiple of fifteen minutes).
const EVERY_15 = '*/15 * * * *'
const MIN = 60_000
const T0 = Date.UTC(2026, 9, 24, 9, 0, 0) // a quarter-hour slot

function automation(id: string, trigger: string, overlap: AutomationOverlap = 'parallel'): AutomationNodeData {
  return {
    id: asNodeId(id), parentId: ROOT_NODE_ID, x: 0, y: 0, zIndex: 0, archivedChildren: [],
    type: 'automation', trigger, overlap, queue: []
  }
}

function terminal(id: string, parentId: NodeId, alive = true): TerminalNodeData {
  return { id: asNodeId(id), parentId, type: 'terminal', alive } as TerminalNodeData
}

/** An in-memory canvas: spawns become terminal children, as on the real one. */
class FakeHost implements AutomationHost {
  nodes = new Map<NodeId, NodeData>()
  spawned: Array<{ automationId: NodeId; line: string; placement?: RunPlacement }> = []
  sent: Array<{ terminalId: NodeId; line: string }> = []
  logs: string[] = []
  private nextId = 0

  add(node: NodeData): void { this.nodes.set(node.id, node) }
  archive(id: NodeId): void { this.nodes.delete(id) }
  get(id: string): AutomationNodeData { return this.nodes.get(asNodeId(id)) as AutomationNodeData }

  automations(): AutomationNodeData[] {
    return [...this.nodes.values()].filter((n): n is AutomationNodeData => n.type === 'automation')
  }
  childrenOf(nodeId: NodeId): NodeData[] {
    return [...this.nodes.values()].filter((n) => n.parentId === nodeId)
  }
  spawn(automationId: NodeId, line: string, placement: RunPlacement): void {
    this.spawned.push({ automationId, line, placement })
    this.add(terminal(`child-${this.nextId++}`, automationId))
  }
  send(terminalId: NodeId, line: string): void { this.sent.push({ terminalId, line }) }
  setQueue(automationId: NodeId, queue: AutomationFiring[]): void { this.get(automationId).queue = queue }
  recordFired(automationId: NodeId, at: number): void { this.get(automationId).lastFiredAt = at }
  log(line: string): void { this.logs.push(line) }
}

class FakeHeartbeat {
  constructor(public value: number | undefined = undefined) {}
  read(): number | undefined { return this.value }
  write(at: number): void { this.value = at }
}

describe('cronSlotsBetween', () => {
  it('excludes the start and includes the end', () => {
    expect(cronSlotsBetween(EVERY_15, T0, T0 + 15 * MIN)).toEqual({ first: T0 + 15 * MIN, last: T0 + 15 * MIN, count: 1 })
    expect(cronSlotsBetween(EVERY_15, T0 - MIN, T0)).toMatchObject({ first: T0, count: 1 })
    expect(cronSlotsBetween(EVERY_15, T0, T0 + 14 * MIN)).toBeUndefined()
  })

  it('counts every slot in a long window', () => {
    expect(cronSlotsBetween(EVERY_15, T0, T0 + 3 * 60 * MIN)).toMatchObject({ first: T0 + 15 * MIN, last: T0 + 180 * MIN, count: 12 })
  })
})

describe('decideFiring', () => {
  const parent = asNodeId('a')
  const one = [terminal('t1', parent)]
  const two = [terminal('t1', parent), terminal('t2', parent)]

  it('parallel always starts another', () => {
    expect(decideFiring('parallel', two, 0)).toEqual({ action: 'spawn' })
  })

  it('single drops while anything is running', () => {
    expect(decideFiring('single', [], 0)).toEqual({ action: 'spawn' })
    expect(decideFiring('single', one, 0).action).toBe('drop')
  })

  it('queue waits behind children and behind earlier firings', () => {
    expect(decideFiring('queue', [], 0)).toEqual({ action: 'spawn' })
    expect(decideFiring('queue', one, 0)).toEqual({ action: 'enqueue' })
    expect(decideFiring('queue', [], 2)).toEqual({ action: 'enqueue' })
  })

  it('reuse sends to a sole live child and drops otherwise', () => {
    expect(decideFiring('reuse', [], 0)).toEqual({ action: 'spawn' })
    expect(decideFiring('reuse', one, 0)).toEqual({ action: 'send', terminalId: one[0].id })
    expect(decideFiring('reuse', two, 0).action).toBe('drop')
    expect(decideFiring('reuse', [terminal('dead', parent, false)], 0).action).toBe('drop')
  })
})

describe('AutomationRunner', () => {
  let host: FakeHost
  let heartbeat: FakeHeartbeat
  let runner: AutomationRunner

  beforeEach(() => {
    host = new FakeHost()
    heartbeat = new FakeHeartbeat()
    runner = new AutomationRunner(host, heartbeat)
  })

  describe('cron', () => {
    it('fires on a slot passing between ticks, with the time and no late note', () => {
      host.add(automation('a', EVERY_15))
      runner.start(T0 + MIN)
      runner.tick(T0 + 10 * MIN)
      expect(host.spawned).toEqual([])
      runner.tick(T0 + 15 * MIN + 5_000)
      expect(host.spawned).toHaveLength(1)
      expect(host.spawned[0].line).toMatch(/^Triggered by: cron at \d{4}-\d\d-\d\dT/)
      expect(host.spawned[0].line).not.toContain('late')
      expect(host.get('a').lastFiredAt).toBe(T0 + 15 * MIN + 5_000)
    })

    it('does not fire for slots before it started, with no heartbeat on record', () => {
      host.add(automation('a', EVERY_15))
      runner.start(T0 + 60 * MIN)
      expect(host.spawned).toEqual([])
    })

    it('catches up once, marked late, for slots missed while the server was down', () => {
      host.add(automation('a', EVERY_15))
      heartbeat.value = T0 - MIN
      runner.start(T0 + 3 * 24 * 60 * MIN + 5 * MIN) // three days down
      expect(host.spawned).toHaveLength(1)
      expect(host.spawned[0].line).toContain('late')
      expect(host.spawned[0].line).toContain('Spaceterm was not running')
      runner.tick(T0 + 3 * 24 * 60 * MIN + 6 * MIN)
      expect(host.spawned).toHaveLength(1)
    })

    it('fires once, late, across a sleep that skipped many ticks', () => {
      host.add(automation('a', EVERY_15))
      runner.start(T0 + MIN)
      runner.tick(T0 + 8 * 60 * MIN + 5 * MIN)
      expect(host.spawned).toHaveLength(1)
      expect(host.spawned[0].line).toContain('late')
    })

    it('is on time, not late, when the run that wakes it lands on a slot', () => {
      host.add(automation('a', EVERY_15))
      runner.start(T0 + MIN)
      runner.tick(T0 + 8 * 60 * MIN)
      expect(host.spawned).toHaveLength(1)
      expect(host.spawned[0].line).not.toContain('late')
    })

    it('is not late when a tick merely lands shortly after the slot', () => {
      host.add(automation('a', EVERY_15))
      runner.start(T0 + MIN)
      runner.tick(T0 + 15 * MIN + LATE_AFTER_MS - 1)
      expect(host.spawned[0].line).not.toContain('late')
    })

    it('keeps the heartbeat current', () => {
      runner.start(T0)
      runner.tick(T0 + 30_000)
      expect(heartbeat.value).toBe(T0 + 30_000)
    })

    it('ignores cards with an empty, invalid or event trigger', () => {
      host.add(automation('a', ''))
      host.add(automation('b', 'every day please'))
      host.add(automation('c', 'custom_x'))
      runner.start(T0 + MIN)
      runner.tick(T0 + 60 * MIN)
      expect(host.spawned).toEqual([])
    })
  })

  describe('events', () => {
    it('fires every card listening for the id, with the payload in the line', () => {
      host.add(automation('a', 'custom_linear'))
      host.add(automation('b', ' custom_linear '))
      host.add(automation('c', 'custom_other'))
      expect(runner.fireEvent('custom_linear', { ticket: 'ENG-1' }, T0)).toBe(2)
      expect(host.spawned.map((s) => s.automationId)).toEqual([asNodeId('a'), asNodeId('b')])
      expect(host.spawned[0].line).toBe('Triggered by: custom_linear, payload:\n{"ticket":"ENG-1"}')
    })

    it('reports zero for an id nothing listens to', () => {
      host.add(automation('a', 'custom_linear'))
      expect(runner.fireEvent('custom_typo', undefined, T0)).toBe(0)
      expect(host.spawned).toEqual([])
    })

    it('omits the payload when none was sent', () => {
      host.add(automation('a', 'custom_ping'))
      runner.fireEvent('custom_ping', undefined, T0)
      expect(host.spawned[0].line).toBe('Triggered by: custom_ping')
    })
  })

  describe('overlap', () => {
    it('single drops a firing while its child runs', () => {
      host.add(automation('a', 'custom_x', 'single'))
      runner.fireEvent('custom_x', 1, T0)
      runner.fireEvent('custom_x', 2, T0)
      expect(host.spawned).toHaveLength(1)
      expect(host.get('a').queue).toEqual([])
    })

    it('queue holds firings in order and starts the next once the child is archived', () => {
      host.add(automation('a', 'custom_x', 'queue'))
      runner.start(T0)
      runner.fireEvent('custom_x', 1, T0)
      runner.fireEvent('custom_x', 2, T0)
      runner.fireEvent('custom_x', 3, T0)
      expect(host.spawned).toHaveLength(1)
      expect(host.get('a').queue.map((f) => f.kind === 'event' && f.payload)).toEqual([2, 3])

      runner.drainQueues()
      expect(host.spawned).toHaveLength(1) // child still there

      host.archive(host.childrenOf(asNodeId('a'))[0].id)
      runner.drainQueues()
      expect(host.spawned.map((s) => s.line)).toEqual(['Triggered by: custom_x, payload:\n1', 'Triggered by: custom_x, payload:\n2'])
      expect(host.get('a').queue).toHaveLength(1)
    })

    it('queued firings keep what they were fired with after the trigger changes', () => {
      host.add(automation('a', 'custom_x', 'queue'))
      runner.fireEvent('custom_x', 1, T0)
      runner.fireEvent('custom_x', 2, T0)
      host.get('a').trigger = EVERY_15
      host.archive(host.childrenOf(asNodeId('a'))[0].id)
      runner.drainQueues()
      expect(host.spawned[1].line).toBe('Triggered by: custom_x, payload:\n2')
    })

    it('reuse sends to its one child instead of starting another', () => {
      host.add(automation('a', 'custom_x', 'reuse'))
      runner.fireEvent('custom_x', 1, T0)
      runner.fireEvent('custom_x', 2, T0)
      expect(host.spawned).toHaveLength(1)
      expect(host.sent).toEqual([{ terminalId: host.childrenOf(asNodeId('a'))[0].id, line: 'Triggered by: custom_x, payload:\n2' }])
    })

    it('parallel starts one per firing, each placed among its siblings', () => {
      host.add(automation('a', 'custom_x', 'parallel'))
      runner.fireEvent('custom_x', 1, T0)
      runner.fireEvent('custom_x', 2, T0)
      expect(host.spawned.map((s) => s.placement)).toEqual(['auto', 'auto'])
    })

    it('every one-at-a-time mode puts its run straight under the card, queued runs included', () => {
      for (const overlap of ['single', 'queue', 'reuse'] as const) {
        host.add(automation(overlap, `custom_${overlap}`, overlap))
        runner.fireEvent(`custom_${overlap}`, 1, T0)
      }
      runner.fireEvent('custom_queue', 2, T0)
      host.archive(host.childrenOf(asNodeId('queue'))[0].id)
      runner.drainQueues()
      expect(host.spawned.map((s) => s.placement)).toEqual(['below', 'below', 'below', 'below'])
    })
  })

  it('a card whose spawn throws does not stop the others', () => {
    host.add(automation('a', 'custom_x'))
    host.add(automation('b', 'custom_x'))
    const spawn = host.spawn.bind(host)
    host.spawn = (id, line, placement) => {
      if (id === asNodeId('a')) throw new Error('no pty')
      spawn(id, line, placement)
    }
    expect(runner.fireEvent('custom_x', undefined, T0)).toBe(2)
    expect(host.spawned.map((s) => s.automationId)).toEqual([asNodeId('b')])
    expect(host.logs.some((l) => l.includes('no pty'))).toBe(true)
  })

  describe('disabled cards', () => {
    const disabled = (id: string, trigger: string, overlap: AutomationOverlap = 'parallel') =>
      ({ ...automation(id, trigger, overlap), enabled: false })

    it('ignore their cron', () => {
      host.add(disabled('a', EVERY_15))
      runner.start(T0 + MIN)
      runner.tick(T0 + 15 * MIN + 5_000)
      expect(host.spawned).toEqual([])
    })

    it('do not hear events, and are not counted as listening', () => {
      host.add(disabled('a', 'custom_x'))
      expect(runner.fireEvent('custom_x', 1, T0)).toBe(0)
      expect(host.spawned).toEqual([])
    })

    it('hold their queue until switched back on', () => {
      host.add({ ...disabled('a', 'custom_x', 'queue'), queue: [{ kind: 'event', at: T0, eventId: 'custom_x', payload: 1 }] })
      runner.drainQueues()
      expect(host.spawned).toEqual([])
      host.get('a').enabled = true
      runner.drainQueues()
      expect(host.spawned).toHaveLength(1)
    })

    it('do not catch up on slots that passed while off', () => {
      host.add(disabled('a', EVERY_15))
      runner.start(T0 + MIN)
      runner.tick(T0 + 20 * MIN)
      host.get('a').enabled = true
      runner.tick(T0 + 25 * MIN)
      expect(host.spawned).toEqual([])
    })

    it('treat a card from before the switch existed as on', () => {
      host.add(automation('a', 'custom_x'))
      expect(runner.fireEvent('custom_x', 1, T0)).toBe(1)
    })
  })
})
