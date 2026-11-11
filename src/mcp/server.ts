import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { type StorageManager } from '../storage/index.js';
import { RunlogMcpTools } from './tools.js';

export const MCP_SERVER_NAME = 'agentrunlog';
export const MCP_SERVER_VERSION = '0.1.3';

const PROJECT_ROOT_PROP = {
  type: 'string',
  description:
    'Absolute path to the target project root directory (containing .agentrunlog/). Defaults to server cwd.',
};

export function createRunlogMcpServer(storageManager?: StorageManager): {
  server: Server;
  tools: RunlogMcpTools;
} {
  const tools = new RunlogMcpTools(storageManager);

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
            projectRoot: PROJECT_ROOT_PROP,
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
            projectRoot: PROJECT_ROOT_PROP,
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
            projectRoot: PROJECT_ROOT_PROP,
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
            projectRoot: PROJECT_ROOT_PROP,
          },
          required: ['approach'],
        },
      },
      {
        name: 'get_active_context',
        description:
          'Quickly fetch pre-compiled high-priority active engineering decisions, recent RCAs, and dead ends for this project (< 5ms).',
        inputSchema: {
          type: 'object',
          properties: {
            projectRoot: PROJECT_ROOT_PROP,
          },
        },
      },
      {
        name: 'record_decision',
        description:
          'Record a new architectural or engineering decision in the project wiki (with optional supersede relation).',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short descriptive title of the decision' },
            context: { type: 'string', description: 'Problem statement and alternatives considered' },
            choice: { type: 'string', description: 'The explicit decision taken' },
            consequences: { type: 'string', description: 'Trade-offs or follow-up constraints' },
            decidedBy: { type: 'string', description: 'Who approved the decision (e.g. "user", "team")' },
            supersedes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of earlier decision IDs this choice replaces (e.g. ["DEC-001"])',
            },
            affectsModules: {
              type: 'array',
              items: { type: 'string' },
              description: 'Affected module paths or globs (e.g. ["src/auth/**"])',
            },
            projectRoot: PROJECT_ROOT_PROP,
          },
          required: ['title', 'context', 'choice'],
        },
      },
      {
        name: 'record_dead_end',
        description:
          'Record a structural Dead End (an architectural approach that fundamentally failed) with mandatory retry conditions.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short descriptive title of the failed approach' },
            approach: { type: 'string', description: 'What was attempted' },
            whyFailed: { type: 'string', description: 'Structural reason why it failed' },
            retryConditions: {
              type: 'string',
              description: 'MANDATORY: Under what specific changed condition this approach could be retried',
            },
            rootCauseType: {
              type: 'string',
              enum: ['architectural', 'limitation', 'incompatibility'],
            },
            affectsModules: {
              type: 'array',
              items: { type: 'string' },
            },
            projectRoot: PROJECT_ROOT_PROP,
          },
          required: ['title', 'approach', 'whyFailed', 'retryConditions'],
        },
      },
      {
        name: 'record_rca',
        description: 'Record a Root Cause Analysis (RCA) of a bug or failure and its verified resolution.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short descriptive title of the incident' },
            incident: { type: 'string', description: 'Observed error or failure symptom' },
            rootCause: { type: 'string', description: 'Exact technical cause' },
            resolution: { type: 'string', description: 'Verified fix implemented' },
            preventativeActions: { type: 'array', items: { type: 'string' } },
            affectsFiles: { type: 'array', items: { type: 'string' } },
            projectRoot: PROJECT_ROOT_PROP,
          },
          required: ['title', 'incident', 'rootCause', 'resolution'],
        },
      },
    ];

    return { tools: toolList };
  });

  // Handle Tool Execution Requests
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const projectRoot = args?.projectRoot ? String(args.projectRoot) : undefined;

    try {
      await tools.ensureBootstrapped(projectRoot);
      switch (name) {
        case 'search_runlog': {
          const query = String(args?.query || '');
          const types = args?.types as any;
          const module = args?.module ? String(args.module) : undefined;
          const includeSuperseded = Boolean(args?.includeSuperseded);

          const result = tools.searchRunlog({
            query,
            types,
            module,
            includeSuperseded,
            projectRoot,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'get_decision': {
          const id = String(args?.id || '');
          const decision = tools.getDecision(id, projectRoot);
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
          const rca = tools.getRCA(id, projectRoot);
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
          const result = tools.checkDeadEnds({ approach, module, projectRoot });
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
          const activeContext = tools.getActiveContext(projectRoot);
          return {
            content: [{ type: 'text', text: activeContext }],
          };
        }

        case 'record_decision': {
          const decision = tools.recordDecision({
            title: String(args?.title || ''),
            context: String(args?.context || ''),
            choice: String(args?.choice || ''),
            consequences: args?.consequences ? String(args.consequences) : undefined,
            decidedBy: args?.decidedBy ? String(args.decidedBy) : undefined,
            supersedes: Array.isArray(args?.supersedes) ? args.supersedes.map(String) : undefined,
            affectsModules: Array.isArray(args?.affectsModules)
              ? args.affectsModules.map(String)
              : undefined,
            projectRoot,
          });
          return {
            content: [
              {
                type: 'text',
                text: `✅ Recorded Decision ${decision.id}: "${decision.title}"\nSaved to .agentrunlog/wiki/decisions/${decision.id}.md and refreshed active context cache.`,
              },
            ],
          };
        }

        case 'record_dead_end': {
          const deadEnd = tools.recordDeadEnd({
            title: String(args?.title || ''),
            approach: String(args?.approach || ''),
            whyFailed: String(args?.whyFailed || ''),
            retryConditions: String(args?.retryConditions || ''),
            rootCauseType: (args?.rootCauseType as any) || 'architectural',
            affectsModules: Array.isArray(args?.affectsModules)
              ? args.affectsModules.map(String)
              : undefined,
            projectRoot,
          });
          return {
            content: [
              {
                type: 'text',
                text: `⚠️ Recorded Dead End ${deadEnd.id}: "${deadEnd.title}"\nSaved to .agentrunlog/wiki/dead-ends/${deadEnd.id}.md.`,
              },
            ],
          };
        }

        case 'record_rca': {
          const rca = tools.recordRCA({
            title: String(args?.title || ''),
            incident: String(args?.incident || ''),
            rootCause: String(args?.rootCause || ''),
            resolution: String(args?.resolution || ''),
            preventativeActions: Array.isArray(args?.preventativeActions)
              ? args.preventativeActions.map(String)
              : undefined,
            affectsFiles: Array.isArray(args?.affectsFiles)
              ? args.affectsFiles.map(String)
              : undefined,
            projectRoot,
          });
          return {
            content: [
              {
                type: 'text',
                text: `🔍 Recorded RCA ${rca.id}: "${rca.title}"\nSaved to .agentrunlog/wiki/rca/${rca.id}.md.`,
              },
            ],
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
