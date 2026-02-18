export interface UndoArchiveEntry {
  nodeId: string
  parentId: string
  reparentedChildIds: string[]
}

const MAX_STACK = 10
const stack: UndoArchiveEntry[] = []

export function pushArchiveUndo(entry: UndoArchiveEntry): void {
  stack.push(entry)
  if (stack.length > MAX_STACK) stack.shift()
}

export function popArchiveUndo(): UndoArchiveEntry | undefined {
  return stack.pop()
}
