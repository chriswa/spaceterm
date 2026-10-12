/**
 * A condition that comes and goes and says when: the canvas being on screen,
 * the phone being in Control mode. What depends on one — a timer, a server
 * subscription — runs `whileOn` it, so it cannot be left running by a
 * forgotten "off" path.
 */
export interface Gate {
  readonly on: boolean
  /** Called on every change, never with the current value. Returns the unsubscribe. */
  subscribe(listener: (on: boolean) => void): () => void
}

export interface SettableGate extends Gate {
  set(on: boolean): void
}

export function createGate(initial: boolean): SettableGate {
  let on = initial
  const listeners = new Set<(on: boolean) => void>()
  return {
    get on() { return on },
    set(next) {
      if (next === on) return
      on = next
      listeners.forEach((listener) => listener(on))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}

/** A gate whose value is `compute` over `inputs`, changing only when the result does. */
export function derivedGate(inputs: readonly Gate[], compute: () => boolean): Gate {
  const gate = createGate(compute())
  inputs.forEach((input) => input.subscribe(() => gate.set(compute())))
  return { get on() { return gate.on }, subscribe: gate.subscribe }
}

export const anyOf = (...gates: Gate[]): Gate => derivedGate(gates, () => gates.some((g) => g.on))
export const not = (gate: Gate): Gate => derivedGate([gate], () => !gate.on)

/**
 * Run `start` whenever `gate` is on; what it returns stops it again when the
 * gate goes off. Returns the uninstall, which also stops it.
 */
export function whileOn(gate: Gate, start: () => () => void): () => void {
  let stop: (() => void) | null = gate.on ? start() : null
  const unsubscribe = gate.subscribe((on) => {
    if (on && !stop) stop = start()
    else if (!on && stop) { stop(); stop = null }
  })
  return () => {
    unsubscribe()
    stop?.()
    stop = null
  }
}
