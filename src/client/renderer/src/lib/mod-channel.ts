/**
 * A mod's typed view of its own envelope channel.
 *
 * `window.api.mods` is deliberately untyped — `modId`, a string event name and
 * an `unknown` payload — because the base cannot know a mod's vocabulary. This
 * is the other half of that bargain: a mod declares its message union once and
 * gets a channel that is as type-safe internally as anything in the base.
 *
 * ```ts
 * type WeatherMsg =
 *   | { event: 'reading'; payload: { tempC: number } }
 *   | { event: 'failed'; payload: { reason: string } }
 *
 * const channel = modChannel<WeatherMsg>('weather')
 * channel.send('reading', { tempC: 12 })          // checked
 * channel.send('reading', { temp: 12 })           // compile error
 * const stop = channel.on('reading', (p) => p.tempC)
 * ```
 *
 * It is a thin wrapper on purpose. A mod that wants request/reply, retries or
 * sequencing builds them on top in its own vocabulary — the base offers
 * fire-and-forget delivery and nothing else, because anything more would mean
 * correlating messages it cannot read.
 */

/** The shape a mod's message union must have: a name and a payload per case. */
export interface ModMessageShape {
  event: string
  payload: unknown
}

type PayloadFor<M extends ModMessageShape, E extends M['event']> =
  Extract<M, { event: E }>['payload']

export interface ModChannel<M extends ModMessageShape> {
  /** Fire one message toward the server and any listening mod process. */
  send<E extends M['event']>(event: E, payload: PayloadFor<M, E>): void
  /** Listen for one of this mod's messages. Returns an unsubscribe. */
  on<E extends M['event']>(event: E, handler: (payload: PayloadFor<M, E>) => void): () => void
  /** Listen for all of them, for a mod that dispatches with its own switch. */
  onAny(handler: (message: M) => void): () => void
}

export function modChannel<M extends ModMessageShape>(modId: string): ModChannel<M> {
  return {
    send(event, payload) {
      window.api.mods.send(modId, event, payload)
    },

    on(event, handler) {
      return window.api.mods.onMessage(modId, (incoming, payload) => {
        // The cast is the boundary. Everything above it is checked; below it,
        // the value crossed a process boundary as JSON and the mod is the only
        // thing that knows what it should be.
        if (incoming === event) handler(payload as PayloadFor<M, typeof event>)
      })
    },

    onAny(handler) {
      return window.api.mods.onMessage(modId, (event, payload) => {
        handler({ event, payload } as M)
      })
    },
  }
}
