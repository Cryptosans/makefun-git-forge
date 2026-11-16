// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server actually send: queries, mutations, aliases, variables,
// inline input objects, inline fragments and batched operation arrays.
// No GraphQL library; the parser is a hand-rolled recursive descent over the
// fixed document shapes, and the resolvers read the forge's store.

import { Store, VIEWER, globalId, parseGlobalId } from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer.
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&='.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      let float = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        float = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        float = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: float ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST and parser.
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; required: boolean }>;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'operation', operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        operations.push(this.parseOperation(token.value as 'query' | 'mutation'));
      } else if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.expectName();
        if (this.peek().value === 'on') {
          this.next();
          this.expectName();
        }
        this.parseSelectionSet();
      } else {
        throw new Error(`unexpected token ${token.value} at document level`);
      }
    }
    return operations;
  }

  private parseOperation(operation: 'query' | 'mutation'): OperationNode {
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: OperationNode['variables'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let required = false;
        if (type.endsWith('!')) required = true;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
        variables.push({ name: varName, type, required });
      }
      this.expectPunct(')');
    }
    // Directives (none in the suite's documents) are skipped.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    const selection = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variables, selection };
  }

  private parseType(): string {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    if (token.kind !== 'name') throw new Error(`expected a type, got ${token.value}`);
    let out = token.value;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        // Named fragment spread: the suite never sends one; treat as empty.
        this.next();
        return { kind: 'fragment', typeCondition: null, selection: [] };
      }
      return { kind: 'fragment', typeCondition: null, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    // Directives on a field are skipped.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    const selection = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

export interface GraphQLError {
  message: string;
  path?: Array<string | number>;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: GraphQLError[];
}

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

interface Context {
  store: Store;
  variables: Variables;
  errors: GraphQLError[];
  path: Array<string | number>;
}

type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: Context, selection: SelectionNode[]) => unknown;

// The wrapped values resolvers pass around, so field resolution knows the type.
interface RepoNode {
  __type: 'Repository';
  repoId: number;
}
interface IssueNode {
  __type: 'Issue';
  repoId: number;
  number: number;
}
interface PullNode {
  __type: 'PullRequest';
  repoId: number;
  number: number;
}
interface UserNode {
  __type: 'User';
  login: string;
}
interface TypeNode {
  __type: '__Type';
  name: string;
}
interface ConnectionNode {
  __type: 'IssueConnection' | 'PullRequestConnection';
  repoId: number;
  items: Array<{ number: number }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function encodeCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function toGraphQLState(state: string): string {
  return state === 'open' ? 'OPEN' : state === 'closed' ? 'CLOSED' : state;
}

function issueNode(repoId: number, number: number): IssueNode {
  return { __type: 'Issue', repoId, number };
}

function pullNode(repoId: number, number: number): PullNode {
  return { __type: 'PullRequest', repoId, number };
}

/** Resolve a selection set against a parent value of a known type. */
function resolveSelection(parentType: string, parent: unknown, selections: SelectionNode[], ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(out, resolveSelection(parentType, parent, selection.selection, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    ctx.path.push(key);
    const resolver = RESOLVERS[parentType]?.[selection.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".`, path: [...ctx.path] });
      ctx.path.pop();
      continue;
    }
    try {
      const value = resolver(parent, argsOf(selection, ctx.variables), ctx, selection.selection);
      out[key] = value;
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...ctx.path] });
      out[key] = null;
    }
    ctx.path.pop();
  }
  return out;
}

/** Resolve a child object field's own selection set (null stays null). */
function child(type: string, value: unknown, selection: SelectionNode[], ctx: Context): unknown {
  if (value === null || value === undefined) return null;
  if (selection.length === 0) return value;
  if (typeof value === 'object') return resolveSelection(type, value, selection, ctx);
  return value;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'databaseId'];
const PULL_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'url', 'databaseId',
];
const REPO_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'description', 'createdAt', 'updatedAt', 'url', 'issue', 'issues',
  'pullRequests', 'pullRequest', 'labels', 'stargazerCount', 'forkCount',
];
const USER_FIELDS = ['id', 'login', 'name', 'email', 'url'];

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_FIELDS,
  Repository: REPO_FIELDS,
  User: USER_FIELDS,
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'TOPIC', 'PACKAGE', 'MARKETPLACE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, ctx, selection) => child('User', { __type: 'User', login: VIEWER.login } satisfies UserNode, selection, ctx),
    repository: (_parent, args, ctx, selection) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return child('Repository', { __type: 'Repository', repoId: repo.id } satisfies RepoNode, selection, ctx);
    },
    node: (_parent, args, ctx, selection) => {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'repo') {
        const repo = ctx.store.getRepoById(parsed.repoId);
        return repo ? child('Repository', { __type: 'Repository', repoId: repo.id } satisfies RepoNode, selection, ctx) : null;
      }
      if (parsed.kind === 'issue') return child('Issue', issueNode(parsed.repoId, parsed.number), selection, ctx);
      if (parsed.kind === 'pull') return child('PullRequest', pullNode(parsed.repoId, parsed.number), selection, ctx);
      return null;
    },
    __type: (_parent, args, ctx, selection) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] || TYPE_ENUM_VALUES[name]) return child('__Type', { __type: '__Type', name } satisfies TypeNode, selection, ctx);
      return null;
    },
  },
  User: {
    id: (parent) => `U${VIEWER.id}`,
    login: (parent) => (parent as UserNode).login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: (parent) => `https://github.com/${(parent as UserNode).login}`,
  },
  Repository: {
    id: (parent, _args, ctx) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      return globalId('repo', repo.id, 0);
    },
    databaseId: (parent) => (parent as RepoNode).repoId,
    name: (parent, _args, ctx) => ctx.store.getRepoById((parent as RepoNode).repoId)!.name,
    nameWithOwner: (parent, _args, ctx) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (parent, _args, ctx, selection) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      return child('User', { __type: 'User', login: repo.owner } satisfies UserNode, selection, ctx);
    },
    defaultBranchRef: (parent, _args, ctx, selection) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      if (!repo.refs.get(`refs/heads/${repo.defaultBranch}`)) return null;
      return child('Ref', { name: repo.defaultBranch }, selection, ctx);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (parent, _args, ctx) => ctx.store.getRepoById((parent as RepoNode).repoId)!.description,
    createdAt: (parent, _args, ctx) => ctx.store.getRepoById((parent as RepoNode).repoId)!.createdAt,
    updatedAt: (parent, _args, ctx) => ctx.store.getRepoById((parent as RepoNode).repoId)!.updatedAt,
    url: (parent, _args, ctx) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      return `https://github.com/${repo.owner}/${repo.name}`;
    },
    issue: (parent, args, ctx, selection) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      const issue = ctx.store.getIssue(repo, Number(args.number));
      if (!issue) return null;
      return child('Issue', issueNode(repo.id, issue.number), selection, ctx);
    },
    issues: (parent, args, ctx, selection) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const field = String(orderBy.field ?? 'CREATED_AT');
      const direction = String(orderBy.direction ?? 'DESC');
      let list = [...repo.issues];
      if (states) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      list.sort((a, b) => {
        let cmp = 0;
        if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
        else if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
        else cmp = a.createdSeq - b.createdSeq;
        if (cmp === 0) cmp = a.number - b.number;
        return direction === 'ASC' ? cmp : -cmp;
      });
      const first = typeof args.first === 'number' ? args.first : list.length;
      const after = decodeCursor(args.after as string | null | undefined);
      if (after !== null) {
        // The cursor names the last item of the previous page in this order.
        const index = list.findIndex((issue) => issue.number === after);
        if (index >= 0) list = list.slice(index + 1);
      }
      const page = list.slice(0, first);
      const hasNextPage = list.length > first;
      const connection: ConnectionNode = {
        __type: 'IssueConnection',
        repoId: repo.id,
        items: page.map((issue) => ({ number: issue.number })),
        pageInfo: { hasNextPage, endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null },
      };
      return child('IssueConnection', connection, selection, ctx);
    },
    pullRequests: (parent, args, ctx, selection) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
      const connection: ConnectionNode = {
        __type: 'PullRequestConnection',
        repoId: repo.id,
        items: list.map((pull) => ({ number: pull.number })),
        pageInfo: { hasNextPage: repo.pulls.length > first, endCursor: null },
      };
      return child('PullRequestConnection', connection, selection, ctx);
    },
    pullRequest: (parent, args, ctx, selection) => {
      const repo = ctx.store.getRepoById((parent as RepoNode).repoId)!;
      const pull = ctx.store.getPull(repo, Number(args.number));
      if (!pull) return null;
      return child('PullRequest', pullNode(repo.id, pull.number), selection, ctx);
    },
    labels: () => [],
    stargazerCount: () => 0,
    forkCount: () => 0,
  },
  Ref: {
    name: (parent) => (parent as { name: string }).name,
  },
  Issue: {
    id: (parent, _args, ctx) => globalId('issue', (parent as IssueNode).repoId, (parent as IssueNode).number),
    number: (parent) => (parent as IssueNode).number,
    title: (parent, _args, ctx) => ctx.store.getIssue(ctx.store.getRepoById((parent as IssueNode).repoId)!, (parent as IssueNode).number)!.title,
    body: (parent, _args, ctx) => ctx.store.getIssue(ctx.store.getRepoById((parent as IssueNode).repoId)!, (parent as IssueNode).number)!.body,
    state: (parent, _args, ctx) => toGraphQLState(ctx.store.getIssue(ctx.store.getRepoById((parent as IssueNode).repoId)!, (parent as IssueNode).number)!.state),
    createdAt: (parent, _args, ctx) => ctx.store.getIssue(ctx.store.getRepoById((parent as IssueNode).repoId)!, (parent as IssueNode).number)!.createdAt,
    updatedAt: (parent, _args, ctx) => ctx.store.getIssue(ctx.store.getRepoById((parent as IssueNode).repoId)!, (parent as IssueNode).number)!.updatedAt,
    closedAt: (parent, _args, ctx) => ctx.store.getIssue(ctx.store.getRepoById((parent as IssueNode).repoId)!, (parent as IssueNode).number)!.closedAt,
    author: (parent, _args, ctx, selection) => child('User', { __type: 'User', login: VIEWER.login } satisfies UserNode, selection, ctx),
    labels: () => [],
    comments: () => [],
    url: (parent, _args, ctx) => {
      const repo = ctx.store.getRepoById((parent as IssueNode).repoId)!;
      return `https://github.com/${repo.owner}/${repo.name}/issues/${(parent as IssueNode).number}`;
    },
    databaseId: (parent, _args, ctx) => ctx.store.getIssue(ctx.store.getRepoById((parent as IssueNode).repoId)!, (parent as IssueNode).number)!.id,
  },
  PullRequest: {
    id: (parent) => globalId('pull', (parent as PullNode).repoId, (parent as PullNode).number),
    number: (parent) => (parent as PullNode).number,
    title: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.title,
    body: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.body,
    state: (parent, _args, ctx) => {
      const pull = ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!;
      return pull.merged ? 'MERGED' : toGraphQLState(pull.state);
    },
    merged: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.merged,
    mergeable: (parent, _args, ctx) => {
      const repo = ctx.store.getRepoById((parent as PullNode).repoId)!;
      const pull = ctx.store.getPull(repo, (parent as PullNode).number)!;
      return ctx.store.pullMergeable(repo, pull);
    },
    headRefName: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.headRef,
    baseRefName: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.baseRef,
    headRef: (parent, _args, ctx, selection) => {
      const pull = ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!;
      return child('Ref', { name: pull.headRef }, selection, ctx);
    },
    baseRef: (parent, _args, ctx, selection) => {
      const pull = ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!;
      return child('Ref', { name: pull.baseRef }, selection, ctx);
    },
    files: (parent, args, ctx, selection) => {
      const repo = ctx.store.getRepoById((parent as PullNode).repoId)!;
      const pull = ctx.store.getPull(repo, (parent as PullNode).number)!;
      const first = typeof args.first === 'number' ? args.first : 100;
      const files = ctx.store.pullFiles(repo, pull).slice(0, first);
      const nodes = files.map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }));
      const connection = { __type: 'PullRequestChangedFileConnection', nodes };
      return child('PullRequestChangedFileConnection', connection, selection, ctx);
    },
    createdAt: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.createdAt,
    updatedAt: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.updatedAt,
    closedAt: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.closedAt,
    mergedAt: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.mergedAt,
    author: (parent, _args, ctx, selection) => child('User', { __type: 'User', login: VIEWER.login } satisfies UserNode, selection, ctx),
    url: (parent, _args, ctx) => {
      const repo = ctx.store.getRepoById((parent as PullNode).repoId)!;
      return `https://github.com/${repo.owner}/${repo.name}/pull/${(parent as PullNode).number}`;
    },
    databaseId: (parent, _args, ctx) => ctx.store.getPull(ctx.store.getRepoById((parent as PullNode).repoId)!, (parent as PullNode).number)!.id,
  },
  IssueConnection: {
    nodes: (parent, _args, ctx, selection) => {
      const connection = parent as ConnectionNode;
      return connection.items.map((item) => child('Issue', issueNode(connection.repoId, item.number), selection, ctx));
    },
    pageInfo: (parent, _args, ctx, selection) => child('PageInfo', (parent as ConnectionNode).pageInfo, selection, ctx),
    totalCount: (parent) => (parent as ConnectionNode).items.length,
  },
  PullRequestConnection: {
    nodes: (parent, _args, ctx, selection) => {
      const connection = parent as ConnectionNode;
      return connection.items.map((item) => child('PullRequest', pullNode(connection.repoId, item.number), selection, ctx));
    },
    pageInfo: (parent, _args, ctx, selection) => child('PageInfo', (parent as ConnectionNode).pageInfo, selection, ctx),
    totalCount: (parent) => (parent as ConnectionNode).items.length,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent, _args, ctx, selection) => {
      const nodes = (parent as { nodes: Array<Record<string, unknown>> }).nodes;
      return nodes.map((node) => child('PullRequestChangedFile', node, selection, ctx));
    },
  },
  PullRequestChangedFile: {
    path: (parent) => (parent as { path: string }).path,
    additions: (parent) => (parent as { additions: number }).additions,
    deletions: (parent) => (parent as { deletions: number }).deletions,
    changeType: (parent) => (parent as { changeType: string }).changeType,
  },
  PageInfo: {
    hasNextPage: (parent) => (parent as { hasNextPage: boolean }).hasNextPage,
    endCursor: (parent) => (parent as { endCursor: string | null }).endCursor,
  },
  __Type: {
    name: (parent) => (parent as TypeNode).name,
    kind: (parent) => (TYPE_ENUM_VALUES[(parent as TypeNode).name] ? 'ENUM' : 'OBJECT'),
    fields: (parent, args, ctx, selection) => {
      const fields = TYPE_FIELDS[(parent as TypeNode).name] ?? [];
      return fields.map((name) => child('__Field', { name }, selection, ctx));
    },
    enumValues: (parent, args, ctx, selection) => {
      const values = TYPE_ENUM_VALUES[(parent as TypeNode).name] ?? [];
      return values.map((name) => child('__EnumValue', { name }, selection, ctx));
    },
    description: () => null,
  },
  __Field: {
    name: (parent) => (parent as { name: string }).name,
  },
  __EnumValue: {
    name: (parent) => (parent as { name: string }).name,
  },
  Mutation: {
    createIssue: (_parent, args, ctx, selection) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'repo') throw new Error(`repositoryId ${JSON.stringify(input.repositoryId)} does not name a repository`);
      const repo = ctx.store.getRepoById(parsed.repoId);
      if (!repo) throw new Error(`repository ${parsed.repoId} does not exist`);
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return child('CreateIssuePayload', { issue: issueNode(repo.id, issue.number) }, selection, ctx);
    },
    closeIssue: (_parent, args, ctx, selection) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (!parsed || parsed.kind !== 'issue') throw new Error(`issueId ${JSON.stringify(input.issueId)} does not name an issue`);
      const repo = ctx.store.getRepoById(parsed.repoId);
      const issue = repo ? ctx.store.getIssue(repo, parsed.number) : undefined;
      if (!issue) throw new Error(`issue ${parsed.number} does not exist`);
      issue.state = 'closed';
      const [, at] = ctx.store.tick();
      issue.closedAt = at;
      issue.updatedAt = at;
      return child('CloseIssuePayload', { issue: issueNode(repo!.id, issue.number) }, selection, ctx);
    },
    createPullRequest: (_parent, args, ctx, selection) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'repo') throw new Error(`repositoryId ${JSON.stringify(input.repositoryId)} does not name a repository`);
      const repo = ctx.store.getRepoById(parsed.repoId);
      if (!repo) throw new Error(`repository ${parsed.repoId} does not exist`);
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const created = ctx.store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
      if ('error' in created) throw new Error(created.error);
      return child('CreatePullRequestPayload', { pullRequest: pullNode(repo.id, created.number) }, selection, ctx);
    },
    mergePullRequest: (_parent, args, ctx, selection) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.kind !== 'pull') throw new Error(`pullRequestId ${JSON.stringify(input.pullRequestId)} does not name a pull request`);
      const repo = ctx.store.getRepoById(parsed.repoId);
      const pull = repo ? ctx.store.getPull(repo, parsed.number) : undefined;
      if (!pull) throw new Error(`pull request ${parsed.number} does not exist`);
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const merged = ctx.store.mergePull(repo!, pull, method);
      if ('error' in merged) throw new Error(merged.error);
      return child('MergePullRequestPayload', { pullRequest: pullNode(repo!.id, pull.number) }, selection, ctx);
    },
    addComment: (_parent, args, ctx, selection) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (!parsed || parsed.kind !== 'issue') throw new Error(`subjectId ${JSON.stringify(input.subjectId)} does not name an issue`);
      const repo = ctx.store.getRepoById(parsed.repoId);
      const issue = repo ? ctx.store.getIssue(repo, parsed.number) : undefined;
      if (!issue) throw new Error(`issue ${parsed.number} does not exist`);
      const comment = ctx.store.addComment(repo!, issue, String(input.body ?? ''));
      const node = { __type: 'IssueComment', id: globalId('comment', repo!.id, issue.number, comment.id), body: comment.body };
      return child('AddCommentPayload', { commentEdge: { node } }, selection, ctx);
    },
  },
  CreateIssuePayload: {
    issue: (parent, _args, ctx, selection) => child('Issue', (parent as { issue: IssueNode }).issue, selection, ctx),
  },
  CloseIssuePayload: {
    issue: (parent, _args, ctx, selection) => child('Issue', (parent as { issue: IssueNode }).issue, selection, ctx),
  },
  CreatePullRequestPayload: {
    pullRequest: (parent, _args, ctx, selection) => child('PullRequest', (parent as { pullRequest: PullNode }).pullRequest, selection, ctx),
  },
  MergePullRequestPayload: {
    pullRequest: (parent, _args, ctx, selection) => child('PullRequest', (parent as { pullRequest: PullNode }).pullRequest, selection, ctx),
  },
  AddCommentPayload: {
    commentEdge: (parent, _args, ctx, selection) => child('IssueCommentEdge', (parent as { commentEdge: unknown }).commentEdge, selection, ctx),
  },
  IssueCommentEdge: {
    node: (parent, _args, ctx, selection) => child('IssueComment', (parent as { node: unknown }).node, selection, ctx),
  },
  IssueComment: {
    id: (parent) => (parent as { id: string }).id,
    body: (parent) => (parent as { body: string }).body,
  },
};

/** Run one operation document. `data` is null only when parsing fails outright. */
export function executeGraphQL(store: Store, query: string, variables: Variables, operationName?: string | null): GraphQLResult {
  let operations: OperationNode[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operationName
    ? operations.find((op) => op.name === operationName)
    : operations[0];
  if (!operation) return { data: null, errors: [{ message: `unknown operation ${JSON.stringify(operationName)}` }] };
  const ctx: Context = { store, variables, errors: [], path: [] };
  for (const variable of operation.variables) {
    if (variable.required && (variables[variable.name] === undefined || variables[variable.name] === null)) {
      return { data: null, errors: [{ message: `Variable $${variable.name} of required type ${variable.type} was not provided.` }] };
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelection(rootType, null, operation.selection, ctx);
  return { data, errors: ctx.errors };
}
