import type { ClientModHost } from '../index'
import { registerBubbleFacet } from './bubble-facet'

/**
 * The summary-chat mod's client half.
 *
 * Today it contributes one thing — the indicator under a surface's toolbar
 * icon — and the rest of the feature is still first-party code in the base.
 * The point of the file is the *shape*: this is what a mod looks like, and
 * extracting the remainder of summarization means moving code into here rather
 * than inventing a mechanism.
 *
 * `register` only declares. There is deliberately no `activate` yet, because
 * nothing here needs to start: a facet is a declaration, and the component
 * that reads it subscribes on its own when it mounts.
 */
export function register(host: ClientModHost): void {
  registerBubbleFacet()
  host.log('bubble facet registered')
}
