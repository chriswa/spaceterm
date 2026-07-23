import { emitMarkdownTool } from './emit-markdown.js'
import { emitMarkdownOnParentTool } from './emit-markdown-on-parent.js'
import { resolveHandoffContextTool } from './resolve-handoff-context.js'
import { spawnClaudeSurfaceTool } from './spawn-claude-surface.js'
import { forkClaudeSurfaceTool } from './fork-claude-surface.js'
import { spacetermBroadcastTool } from './spaceterm-broadcast.js'
import { playSoundTool } from './play-sound.js'
import { speakTool } from './speak.js'
import { startStdioServer } from './stdio-mcp.js'
import { recoverSpacetermEnvFromAncestors } from './surface-env.js'

recoverSpacetermEnvFromAncestors()

startStdioServer({
  name: 'spaceterm-mcp',
  version: '0.1.0',
  tools: [emitMarkdownTool, emitMarkdownOnParentTool, resolveHandoffContextTool, spawnClaudeSurfaceTool, forkClaudeSurfaceTool, spacetermBroadcastTool, playSoundTool, speakTool],
}).catch((error: unknown) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
