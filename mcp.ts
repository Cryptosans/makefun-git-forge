// mcp.ts — the Model Context Protocol endpoint (2026-07-28 revision):
// server/discover, tools/list and tools/call over plain JSON-RPC 2.0.
// No sessions, no SSE: every POST is answered by one JSON body.
// The six tools act on the same store as REST and GraphQL.

import { Store, VIEWER } from './store.ts';

export const MCP_VERSION = '2026-07-28';
export const SERVER_NAME = 'git-forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingArgs(args: Record<string, unknown>, required: string[]): string[] {
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return errorResult(`unknown tool ${name}`);
  const missing = missingArgs(args, tool.inputSchema.required);
  if (missing.length > 0) return errorResult(`missing required argument(s): ${missing.join(', ')}`);
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.name ?? '');

  if (name === 'create_repo') {
    const repoNameArg = String(args.name ?? '');
    if (store.getRepo(VIEWER.login, repoNameArg)) return errorResult(`repository ${VIEWER.login}/${repoNameArg} already exists`);
    const repo = store.createRepo(repoNameArg, args.private === true, typeof args.description === 'string' ? args.description : '');
    return okResult(store.repoView(repo));
  }
  if (name === 'get_repo') {
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    return okResult(store.repoView(repo));
  }
  if (name === 'create_issue') {
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
    return okResult(store.issueView(repo, issue));
  }
  if (name === 'list_issues') {
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const state = args.state === 'closed' ? 'closed' : args.state === 'all' ? 'all' : 'open';
    const issues = store.listIssues(repo, state, 'created', 'desc').map((issue) => store.issueView(repo, issue));
    return { content: [{ type: 'text', text: JSON.stringify(issues) }], structuredContent: { issues } };
  }
  if (name === 'create_pull_request') {
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const created = store.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', String(args.head ?? ''), String(args.base ?? ''));
    if ('error' in created) return errorResult(created.error);
    return okResult(store.pullView(repo, created));
  }
  if (name === 'merge_pull_request') {
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const pull = store.getPull(repo, Number(args.pull_number));
    if (!pull) return errorResult(`pull request ${String(args.pull_number)} not found`);
    const merged = store.mergePull(repo, pull, 'squash');
    if ('error' in merged) return errorResult(merged.error);
    return okResult({ ...store.pullView(repo, pull), sha: merged.sha, message: merged.message });
  }
  return errorResult(`unknown tool ${name}`);
}

export interface McpOutcome {
  status: number;
  json: unknown;
}

/**
 * Handle one JSON-RPC 2.0 request body (already parsed). Notifications
 * (no id) are answered by the caller with 202; this function only handles
 * requests. A body that is not a JSON-RPC request gets -32600.
 */
export function handleMcp(store: Store, body: unknown): McpOutcome {
  if (!isRecord(body) || typeof body.method !== 'string') {
    return { status: 200, json: { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  if (method === 'server/discover') {
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: [MCP_VERSION],
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        },
      },
    };
  }
  if (method === 'initialize') {
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo },
      },
    };
  }
  if (method === 'tools/list') {
    return { status: 200, json: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (TOOLS.every((tool) => tool.name !== toolName)) {
      return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${toolName}` } } };
    }
    const result = callTool(store, toolName, args);
    return { status: 200, json: { jsonrpc: '2.0', id, result } };
  }
  return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
}
