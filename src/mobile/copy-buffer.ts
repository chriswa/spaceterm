import type { NodeId } from '../shared/ids'
import { showToast } from '@/lib/toast'
import { copyNatively } from './native-clipboard'

/**
 * A terminal's buffer as one long line: every row trimmed and joined with
 * nothing between them. It is for getting a long link out — one a TUI such as
 * Claude Code broke across rows and indented — whole, into a browser; words
 * on either side of a row break run together, which a link would not survive
 * any other way.
 */
export function flattenBuffer(text: string): string {
  return text.split('\n').map((line) => line.trim()).join('')
}

/** The surface's whole buffer onto the phone's clipboard, with a toast saying how it went. */
export async function copyTerminalBuffer(nodeId: NodeId): Promise<void> {
  try {
    const text = await window.api.node.terminalBufferText(nodeId)
    if (text === null) {
      showToast('Nothing to copy: this surface has no running session')
      return
    }
    const line = flattenBuffer(text)
    if (await copyNatively(line)) showToast(`Copied ${line.length.toLocaleString()} characters`)
    else showToast('Could not copy to the clipboard')
  } catch (err) {
    showToast(`Could not copy: ${err instanceof Error ? err.message : String(err)}`)
  }
}
