import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { StorageManager } from '../storage/index.js';
import { RunlogMcpTools } from './tools.js';

export const MCP_SERVER_NAME = 'agentrunlog';
export const MCP_SERVER_VERSION = '0.1.0';

export function createRunlogMcpServer(storageManager?: StorageManager): {
  server: Server;
  tools: RunlogMcpTools;
} {
  const storage = storageManager || new StorageManager();
  const tools = new RunlogMcpTools(storage);

  const server = new Server(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List Available MCP Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const toolList: Tool[] = [
      {
        name: 'search_runlog',
        description:
          'Search across recorded engineering decisions, root cause analyses (RCA), and known dead ends in the project memory.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keywords to search for (e.g. "authentication", "sqlite", "docker")',
            },
            types: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['decision', 'rca', 'dead_end', 'task', 'run'],
              },
              description: 'Optional filter by record type',
            },
            module: {
              type: 'string',
              description: 'Optional module or file path filter (e.g. "src/auth")',
            },
            includeSuperseded: {
              type: 'boolean',
              description: 'Whether to include outdated/superseded decisions (default false)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_decision',
        description:
          'Retrieve full details of an engineering decision, including context, rationale, consequences, and supersede status.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Decision ID (e.g. "DEC-001")',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'get_rca',
        description: 'Retrieve full details of a Root Cause Analysis (RCA) and its preventative fixes.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'RCA ID (e.g. "RCA-001")',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'check_dead_ends',
        description:
          'Soft Guardrail Check: Check if an approach has already failed before in this codebase, why it failed, and under what conditions it may be retried.',
        inputSchema: {
          type: 'object',
          properties: {
            approach: {
              type: 'string',
              description: 'The approach or technical solution you are considering attempting',
            },
            module: {
              type: 'string',
              description: 'Optional target module or file path',
            },
          },
          required: ['approach'],
        },
      },
      {
        name: 'get_active_context',
        description:
          'Quickly fetch pre-compiled high-priority active engineering decisions and dead ends for this project (< 5ms).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];

    return { tools: toolList };
  });

  // Handle Tool Execution Requests
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'search_runlog': {
          const query = String(args?.query || '');
          const types = args?.types as any;
          const module = args?.module ? String(args.module) : undefined;
          const includeSuperseded = Boolean(args?.includeSuperseded);

          const result = tools.searchRunlog({ query, types, module, includeSuperseded });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'get_decision': {
          const id = String(args?.id || '');
          const decision = tools.getDecision(id);
          if (!decision) {
            return {
              content: [{ type: 'text', text: `Decision with ID "${id}" was not found.` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }],
          };
        }

        case 'get_rca': {
          const id = String(args?.id || '');
          const rca = tools.getRCA(id);
          if (!rca) {
            return {
              content: [{ type: 'text', text: `RCA with ID "${id}" was not found.` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(rca, null, 2) }],
          };
        }

        case 'check_dead_ends': {
          const approach = String(args?.approach || '');
          const module = args?.module ? String(args.module) : undefined;
          const result = tools.checkDeadEnds({ approach, module });
          return {
            content: [
              {
                type: 'text',
                text: result.hasKnownFailures
                  ? `${result.warningMessage}\n\nDetails:\n${JSON.stringify(result.deadEnds, null, 2)}`
                  : '✅ No previous failures recorded for this approach. You may proceed.',
              },
            ],
          };
        }

        case 'get_active_context': {
          const activeContext = tools.getActiveContext();
          return {
            content: [{ type: 'text', text: activeContext }],
          };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error executing ${name}: ${err?.message || String(err)}` }],
        isError: true,
      };
    }
  });

  return { server, tools };
}

// Start stdio server if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = createRunlogMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}
