import { emitMarkdownTool } from './emit-markdown.js'
import { startStdioServer } from './stdio-mcp.js'

startStdioServer({
  name: 'spaceterm-mcp',
  version: '0.1.0',
  tools: [emitMarkdownTool],
}).catch((error: unknown) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
