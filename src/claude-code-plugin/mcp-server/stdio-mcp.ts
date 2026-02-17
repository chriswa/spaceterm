import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool as MCPTool,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export function defineTool<TInput extends z.ZodType>(config: {
  name: string
  description: string
  inputSchema: TInput
  handler: (args: z.infer<TInput>) => Promise<CallToolResult>
}) {
  // Convert Zod schema to JSON Schema for MCP protocol
  const jsonSchema = z.toJSONSchema(config.inputSchema, {
    target: 'jsonSchema2020-12',
    unrepresentable: 'any',
  })

  const mcpTool: MCPTool = {
    name: config.name,
    description: config.description,
    inputSchema: jsonSchema as MCPTool['inputSchema'],
  }

  return {
    name: config.name,
    schema: mcpTool,
    validate: (args: unknown): z.infer<TInput> => config.inputSchema.parse(args),
    handler: config.handler as (args: unknown) => Promise<CallToolResult>,
  }
}

export interface Tool {
  name: string
  schema: MCPTool
  validate: (args: unknown) => unknown
  handler: (args: unknown) => Promise<CallToolResult>
}

export interface MCPServerConfig {
  name: string
  version: string
  description?: string
  tools: Array<Tool>
}

function createMCPServer(config: MCPServerConfig): Server {
  const server = new Server(
    {
      name: config.name,
      version: config.version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  const toolMap = new Map(config.tools.map((tool) => [tool.name, tool]))
  const toolSchemas = config.tools.map((tool) => tool.schema)

  // Register list_tools handler
  server.setRequestHandler(ListToolsRequestSchema, () => {
    console.error(`[MCP] list_tools called, returning ${toolSchemas.length} tool(s)`)
    console.error(`[MCP] Available tools: ${toolSchemas.map((t) => t.name).join(', ')}`)
    return { tools: toolSchemas }
  })

  // Register call_tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    console.error(`[MCP] call_tool: ${name}`)
    console.error(`[MCP] Arguments: ${JSON.stringify(args, null, 2)}`)

    const tool = toolMap.get(name)

    if (!tool) {
      console.error(`[MCP] ERROR: Unknown tool: ${name}`)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2),
          },
        ],
        isError: true,
      }
    }

    try {
      console.error('[MCP] Validating arguments...')
      const validatedArgs = tool.validate(args)
      console.error('[MCP] Arguments validated successfully')
      console.error('[MCP] Executing tool handler...')
      const result = await tool.handler(validatedArgs)
      console.error('[MCP] Tool executed successfully')
      return result
    }
    catch (error: unknown) {
      // Centralized error handling
      let details: unknown
      if (error instanceof z.ZodError) {
        details = error.issues
        console.error('[MCP] Validation error:', error.issues)
      }
      else if (error instanceof Error) {
        details = error.message
        console.error('[MCP] Execution error:', error.message)
        console.error('[MCP] Stack trace:', error.stack)
      }
      else {
        details = String(error)
        console.error('[MCP] Unknown error:', error)
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'Tool execution failed',
                details,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      }
    }
  })

  return server
}

export async function startStdioServer(config: MCPServerConfig): Promise<void> {
  // If running in a terminal (not launched by MCP client), show warning
  if (process.stdin.isTTY) {
    console.error('⚠️  This is an MCP server - it should not be run directly!')
    console.error('See README.md for setup instructions.')
    process.exit(1)
  }

  const server = createMCPServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Log to stderr so it doesn't interfere with stdio protocol
  console.error(`${config.name} MCP server running`)
}
