import type { NodeId } from './ids'

/** Why the user was notified: one of the three prompts only they can answer, or an agent's `notify_user`. */
export type NotificationKind = 'permission' | 'question' | 'plan' | 'manual'

/** One notification the server sent towards the user's phone, for the toolbar's history. */
export interface NotificationRecord {
  /** Increases over the history's whole life, across server restarts. */
  seq: number
  /** epoch ms it was sent. */
  at: number
  nodeId: NodeId
  kind: NotificationKind
  /** The surface's title as it was then. */
  title: string
  /** What the notification said, shortened. */
  body: string
  /** False when no phone could be reached: no push sent and none connected. */
  reached: boolean
}
