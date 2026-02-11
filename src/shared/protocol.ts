import { join } from 'path'
import { homedir } from 'os'

export const SOCKET_DIR = join(homedir(), '.termgraph')
export const SOCKET_PATH = join(SOCKET_DIR, 'termgraph.sock')

export interface SessionInfo {
  sessionId: string
  cols: number
  rows: number
}

// --- Client → Server messages ---

export interface CreateMessage {
  type: 'create'
  seq: number
}

export interface ListMessage {
  type: 'list'
  seq: number
}

export interface AttachMessage {
  type: 'attach'
  seq: number
  sessionId: string
}

export interface DetachMessage {
  type: 'detach'
  seq: number
  sessionId: string
}

export interface DestroyMessage {
  type: 'destroy'
  seq: number
  sessionId: string
}

export interface WriteMessage {
  type: 'write'
  sessionId: string
  data: string
}

export interface ResizeMessage {
  type: 'resize'
  sessionId: string
  cols: number
  rows: number
}

export type ClientMessage =
  | CreateMessage
  | ListMessage
  | AttachMessage
  | DetachMessage
  | DestroyMessage
  | WriteMessage
  | ResizeMessage

// --- Server → Client messages ---

export interface CreatedMessage {
  type: 'created'
  seq: number
  sessionId: string
  cols: number
  rows: number
}

export interface ListedMessage {
  type: 'listed'
  seq: number
  sessions: SessionInfo[]
}

export interface AttachedMessage {
  type: 'attached'
  seq: number
  sessionId: string
  scrollback: string
}

export interface DetachedMessage {
  type: 'detached'
  seq: number
  sessionId: string
}

export interface DestroyedMessage {
  type: 'destroyed'
  seq: number
}

export interface DataMessage {
  type: 'data'
  sessionId: string
  data: string
}

export interface ExitMessage {
  type: 'exit'
  sessionId: string
  exitCode: number
}

export type ServerMessage =
  | CreatedMessage
  | ListedMessage
  | AttachedMessage
  | DetachedMessage
  | DestroyedMessage
  | DataMessage
  | ExitMessage
