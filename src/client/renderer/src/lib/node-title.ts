import type { NodeData } from '../../../../shared/state'

/** Terminal-specific subtitle: shell title history joined with ↼ separators */
export function terminalSubtitle(shellTitleHistory: string[]): string {
  return shellTitleHistory.join(' \u00A0\u21BC\u00A0\u00A0')
}

/** Type-dispatched subtitle (does NOT include data.name) */
export function nodeDisplaySubtitle(data: NodeData): string {
  if (data.type === 'terminal') {
    return terminalSubtitle(data.shellTitleHistory ?? [])
  }
  if (data.type === 'markdown') {
    const firstLine = data.content.split('\n').find(l => l.trim().length > 0)
    if (firstLine) return firstLine.replace(/^#+\s*/, '').trim()
    return ''
  }
  if (data.type === 'image') {
    return ''
  }
  return ''
}

/** Full display title: name ↼ subtitle, with fallback to [Untitled] for terminals */
export function nodeDisplayTitle(data: NodeData): string {
  const parts: string[] = []
  if (data.name) parts.push(data.name)
  const subtitle = nodeDisplaySubtitle(data)
  if (subtitle) parts.push(subtitle)
  if (parts.length > 0) return parts.join(' \u00A0\u21BC\u00A0 ')
  if (data.type === 'terminal') return '[Untitled]'
  return data.id.slice(0, 8)
}
