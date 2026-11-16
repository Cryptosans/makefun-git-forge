// app.ts — the forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and
// MCP, all on one node:http server, all in memory, no disk, no outside calls.
// Auth: any non-empty `Authorization: Bearer <token>` is the viewer; a request
// without it is 401. A repository belongs to the viewer, so the same name
// under another owner is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER } from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  ZERO_OID,
  buildTreeFromMap,
  decodePktLines,
  encodeDelim,
  encodeFlush,
  encodePktLine,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parsePktStream,
  parseTag,
  parseTree,
  readPack,
  selectFetch,
  writePack,
} from './gitcore.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  host: string;
}

function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.store.nextRequestId(),
    ...headers,
  });
  ctx.res.end(text);
}

function sendRaw(ctx: Ctx, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.store.nextRequestId(),
    ...headers,
  });
  ctx.res.end(body);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

async function readBody(ctx: Ctx): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of ctx.req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authed(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization ?? '';
  return header.startsWith('Bearer ') && header.slice(7).trim() !== '';
}

function requireAuth(ctx: Ctx): boolean {
  if (authed(ctx)) return true;
  sendError(ctx, 401, 'Requires authentication');
  return false;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Split a path into decoded segments. */
function segments(path: string): string[] | null {
  const parts = path.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of parts) {
    const decoded = decodeSegment(part);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

function userView(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U${VIEWER.id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}`,
    gravatar_id: '',
    url: '/api/v3/user',
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function pageOf(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages };
}

function linkHeader(ctx: Ctx, basePath: string, page: number, totalPages: number, perPage: number): string {
  const url = (p: number): string => `http://${ctx.host}${basePath}?page=${p}&per_page=${perPage}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(totalPages)}>; rel="last"`);
  return links.join(', ');
}

function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** The owner of a route must be the viewer; anything else is a 404, never a 403. */
function repoFor(ctx: Ctx, owner: string, name: string): ReturnType<Store['getRepo']> {
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return undefined;
  return ctx.store.getRepo(owner, name);
}

// ---------------------------------------------------------------------------
// REST v3.
// ---------------------------------------------------------------------------

async function handleRest(ctx: Ctx, segs: string[]): Promise<boolean> {
  const { store, method } = ctx;

  // API root: public, like the starter's.
  if (segs.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  if (segs[0] === 'meta') {
    if (!requireAuth(ctx)) return true;
    if (method === 'GET') {
      sendJson(ctx, 200, { installed_version: '1.0.0' });
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  if (!requireAuth(ctx)) return true;

  if (segs[0] === 'user' && segs.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, 200, userView());
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageOf(ctx);
      const all = store.listRepos();
      const { page: slice, totalPages } = paginate(all, page, perPage);
      sendJson(ctx, 200, slice.map((repo) => store.repoView(repo)), { link: linkHeader(ctx, '/api/v3/user/repos', page, totalPages, perPage) });
      return true;
    }
    if (method === 'POST') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(ctx));
      } catch {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      if (!isRecord(body) || typeof body.name !== 'string' || body.name.trim() === '') {
        sendError(ctx, 422, 'Validation Failed: name is required');
        return true;
      }
      const name = body.name.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
        sendError(ctx, 422, `Validation Failed: ${JSON.stringify(name)} is not a valid repository name`);
        return true;
      }
      if (store.getRepo(VIEWER.login, name)) {
        sendError(ctx, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      sendJson(ctx, 201, store.repoView(repo));
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = segs[1]!;
    const name = segs[2]!;
    const rest = segs.slice(3);
    const repo = repoFor(ctx, owner, name);
    if (!repo) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(ctx, 200, store.repoView(repo));
        return true;
      }
      if (method === 'PATCH') {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(ctx));
        } catch {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        if (isRecord(body)) {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.private = body.private;
          if (typeof body.default_branch === 'string' && store.branchTip(repo, body.default_branch)) repo.defaultBranch = body.default_branch;
          if (typeof body.name === 'string' && body.name !== repo.name && /^[A-Za-z0-9._-]+$/.test(body.name) && !store.getRepo(owner, body.name)) {
            store.repos.delete(store.repoKey(owner, repo.name));
            repo.name = body.name;
            store.repos.set(store.repoKey(owner, repo.name), repo);
          }
          const [, at] = store.tick();
          repo.updatedAt = at;
        }
        sendJson(ctx, 200, store.repoView(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        ctx.res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
        ctx.res.end();
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(ctx, 200, store.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })));
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = rest[1]!;
        const sha = store.branchTip(repo, branch);
        if (!sha) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, { name: branch, commit: { sha }, protected: false });
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const { page, perPage } = pageOf(ctx);
      const all = store.listCommits(repo, ref, 1000);
      const { page: slice, totalPages } = paginate(all, page, perPage);
      const view = slice.map((commit) => {
        const parsePerson = (line: string): { name: string; email: string; date: string } => {
          const match = /^(.*) <([^>]*)> (\d+) \+0000$/.exec(line);
          if (!match) return { name: line, email: '', date: repo.createdAt };
          return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]!) * 1000).toISOString() };
        };
        const author = parsePerson(commit.author);
        const committer = parsePerson(commit.committer);
        return {
          sha: commit.sha,
          // The raw commit stores the message with git's trailing newline;
          // the API presents it without, exactly as it was submitted.
          commit: { message: commit.message.replace(/\n$/, ''), author, committer },
          author: { login: VIEWER.login, id: VIEWER.id },
          committer: { login: VIEWER.login, id: VIEWER.id },
          parents: commit.parents.map((sha) => ({ sha })),
        };
      });
      sendJson(ctx, 200, view, { link: linkHeader(ctx, `/api/v3/repos/${owner}/${name}/commits`, page, totalPages, perPage) });
      return true;
    }

    // /repos/{o}/{r}/git/refs[/...]
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(ctx));
        } catch {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
          sendError(ctx, 422, 'Validation Failed: ref and sha are required');
          return true;
        }
        const ref = body.ref;
        const sha = body.sha;
        if (!ref.startsWith('refs/') || !isOid(sha)) {
          sendError(ctx, 422, 'Validation Failed: ref must start with refs/ and sha must be a 40-hex object id');
          return true;
        }
        const obj = repo.objects.get(sha);
        if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
          sendError(ctx, 422, 'Validation Failed: sha does not name a commit or tag in this repository');
          return true;
        }
        if (repo.refs.has(ref)) {
          sendError(ctx, 422, 'Validation Failed: reference already exists');
          return true;
        }
        store.setRef(repo, ref, sha);
        sendJson(ctx, 201, { ref, object: { sha, type: obj.type } });
        return true;
      }
      if (method === 'GET') {
        const ref = rest.length > 2 ? `refs/${rest.slice(2).join('/')}` : '';
        if (ref === '') {
          sendJson(ctx, 200, store.listRefs(repo).map((entry) => ({ ref: entry.ref, object: { sha: entry.oid, type: repo.objects.get(entry.oid)?.type ?? 'commit' } })));
          return true;
        }
        const oid = repo.refs.get(ref);
        if (!oid) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/contents[/path...]
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? ctx.query.get('branch') ?? repo.defaultBranch;
        if (path === '') {
          const dir = store.listDirAt(repo, ref, '');
          if (dir === null) {
            sendError(ctx, 404, 'Not Found');
            return true;
          }
          sendJson(ctx, 200, dir.map((entry) => ({ ...entry, url: `/api/v3/repos/${owner}/${name}/contents/${entry.path}`, html_url: `https://github.com/${owner}/${name}/blob/${ref}/${entry.path}`, git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.sha}`, download_url: `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${entry.path}` })));
          return true;
        }
        const file = store.readFileAt(repo, ref, path);
        if (file) {
          sendJson(ctx, 200, {
            type: 'file', encoding: 'base64', size: file.data.length,
            name: path.split('/').pop(), path, content: file.data.toString('base64'), sha: file.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
            html_url: `https://github.com/${owner}/${name}/blob/${ref}/${path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${file.oid}`,
            download_url: `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${path}`,
          });
          return true;
        }
        const dir = store.listDirAt(repo, ref, path);
        if (dir !== null) {
          sendJson(ctx, 200, dir.map((entry) => ({ ...entry, url: `/api/v3/repos/${owner}/${name}/contents/${entry.path}`, html_url: `https://github.com/${owner}/${name}/blob/${ref}/${entry.path}`, git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.sha}`, download_url: `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${entry.path}` })));
          return true;
        }
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if ((method === 'PUT' || method === 'DELETE') && path !== '') {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(ctx));
        } catch {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        if (!isRecord(body) || typeof body.message !== 'string' || body.message === '') {
          sendError(ctx, 422, 'Validation Failed: message is required');
          return true;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : (ctx.query.get('branch') ?? repo.defaultBranch);
        const current = store.readFileAt(repo, branch, path);
        if (method === 'PUT') {
          if (typeof body.content !== 'string') {
            sendError(ctx, 422, 'Validation Failed: content is required');
            return true;
          }
          if (current) {
            if (typeof body.sha !== 'string' || body.sha === '') {
              sendError(ctx, 422, 'Validation Failed: sha is required to update a file');
              return true;
            }
            if (body.sha !== current.oid) {
              sendError(ctx, 409, 'Conflict: sha does not match the current file');
              return true;
            }
          }
          const content = b64decode(body.content);
          const commitOid = store.commitFile(repo, branch, path, content, body.message);
          const blobOid = hashObject('blob', content);
          sendJson(ctx, current ? 200 : 201, {
            content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
            commit: { sha: commitOid, message: body.message },
          });
          return true;
        }
        // DELETE
        if (!current) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        if (typeof body.sha !== 'string' || body.sha === '') {
          sendError(ctx, 422, 'Validation Failed: sha is required to delete a file');
          return true;
        }
        if (body.sha !== current.oid) {
          sendError(ctx, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        const commitOid = store.commitFile(repo, branch, path, null, body.message);
        sendJson(ctx, 200, { commit: { sha: commitOid, message: body.message }, content: null });
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(ctx, 200, [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description, default: false, url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(label.name)}` })));
        return true;
      }
      if (method === 'POST' && rest.length === 1) {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(ctx));
        } catch {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        if (!isRecord(body) || typeof body.name !== 'string' || body.name.trim() === '') {
          sendError(ctx, 422, 'Validation Failed: name is required');
          return true;
        }
        if (repo.labels.has(body.name)) {
          sendError(ctx, 422, 'Validation Failed: label already exists');
          return true;
        }
        const label = store.createLabel(repo, body.name, typeof body.color === 'string' ? body.color : 'ffffff', typeof body.description === 'string' ? body.description : '');
        sendJson(ctx, 201, { id: label.id, name: label.name, color: label.color, description: label.description, default: false, url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(label.name)}` });
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          let body: unknown;
          try {
            body = parseJsonBody(await readBody(ctx));
          } catch {
            sendError(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          if (!isRecord(body) || typeof body.title !== 'string' || body.title.trim() === '') {
            sendError(ctx, 422, 'Validation Failed: title is required');
            return true;
          }
          const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
          const unknown = labels.filter((label) => !repo.labels.has(label));
          if (unknown.length > 0) {
            sendError(ctx, 422, `Validation Failed: label ${unknown[0]} does not exist`);
            return true;
          }
          const issue = store.createIssue(repo, body.title, typeof body.body === 'string' ? body.body : '', labels);
          sendJson(ctx, 201, store.issueView(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') === 'closed' ? 'closed' : ctx.query.get('state') === 'all' ? 'all' : 'open';
          const sort = ctx.query.get('sort') === 'updated' ? 'updated' : 'created';
          const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
          const { page, perPage } = pageOf(ctx);
          const all = store.listIssues(repo, state, sort, direction);
          const { page: slice, totalPages } = paginate(all, page, perPage);
          sendJson(ctx, 200, slice.map((issue) => store.issueView(repo, issue)), { link: linkHeader(ctx, `/api/v3/repos/${owner}/${name}/issues`, page, totalPages, perPage) });
          return true;
        }
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const issue = store.getIssue(repo, number);
      if (!issue) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(ctx, 200, store.issueView(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          let body: unknown;
          try {
            body = parseJsonBody(await readBody(ctx));
          } catch {
            sendError(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          if (isRecord(body)) {
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (Array.isArray(body.labels)) {
              const labels = body.labels.filter((label): label is string => typeof label === 'string');
              const unknown = labels.filter((label) => !repo.labels.has(label));
              if (unknown.length > 0) {
                sendError(ctx, 422, `Validation Failed: label ${unknown[0]} does not exist`);
                return true;
              }
              issue.labels = labels;
            }
            if (body.state === 'closed' && issue.state !== 'closed') {
              issue.state = 'closed';
              const [, at] = store.tick();
              issue.closedAt = at;
              issue.updatedAt = at;
            } else if (body.state === 'open' && issue.state !== 'open') {
              issue.state = 'open';
              issue.closedAt = null;
              const [, at] = store.tick();
              issue.updatedAt = at;
            }
          }
          sendJson(ctx, 200, store.issueView(repo, issue));
          return true;
        }
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if (rest[2] === 'comments' && rest.length === 3) {
        if (method === 'GET') {
          sendJson(ctx, 200, issue.comments.map((comment) => store.commentView(repo, issue, comment)));
          return true;
        }
        if (method === 'POST') {
          let body: unknown;
          try {
            body = parseJsonBody(await readBody(ctx));
          } catch {
            sendError(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          if (!isRecord(body) || typeof body.body !== 'string' || body.body === '') {
            sendError(ctx, 422, 'Validation Failed: body is required');
            return true;
          }
          const comment = store.addComment(repo, issue, body.body);
          sendJson(ctx, 201, store.commentView(repo, issue, comment));
          return true;
        }
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          let body: unknown;
          try {
            body = parseJsonBody(await readBody(ctx));
          } catch {
            sendError(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          if (!isRecord(body) || typeof body.title !== 'string' || body.title.trim() === '' || typeof body.head !== 'string' || typeof body.base !== 'string') {
            sendError(ctx, 422, 'Validation Failed: title, head and base are required');
            return true;
          }
          const head = body.head.includes(':') ? body.head.split(':').pop()! : body.head;
          const base = body.base.includes(':') ? body.base.split(':').pop()! : body.base;
          const created = store.createPull(repo, body.title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in created) {
            sendError(ctx, 422, `Validation Failed: ${created.error}`);
            return true;
          }
          sendJson(ctx, 201, store.pullView(repo, created));
          return true;
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') === 'closed' ? 'closed' : ctx.query.get('state') === 'all' ? 'all' : 'open';
          const { page, perPage } = pageOf(ctx);
          const all = store.listPulls(repo, state);
          const { page: slice, totalPages } = paginate(all, page, perPage);
          sendJson(ctx, 200, slice.map((pull) => store.pullView(repo, pull)), { link: linkHeader(ctx, `/api/v3/repos/${owner}/${name}/pulls`, page, totalPages, perPage) });
          return true;
        }
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const pull = store.getPull(repo, number);
      if (!pull) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(ctx, 200, store.pullView(repo, pull));
          return true;
        }
        if (method === 'PATCH') {
          let body: unknown;
          try {
            body = parseJsonBody(await readBody(ctx));
          } catch {
            sendError(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          if (isRecord(body)) {
            if (typeof body.title === 'string') pull.title = body.title;
            if (typeof body.body === 'string') pull.body = body.body;
            if (body.state === 'closed' && pull.state === 'open') {
              pull.state = 'closed';
              const [, at] = store.tick();
              pull.closedAt = at;
              pull.updatedAt = at;
            }
          }
          sendJson(ctx, 200, store.pullView(repo, pull));
          return true;
        }
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if (rest[2] === 'files' && rest.length === 3 && method === 'GET') {
        sendJson(ctx, 200, store.pullFiles(repo, pull));
        return true;
      }
      if (rest[2] === 'merge' && rest.length === 3 && method === 'PUT') {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(ctx));
        } catch {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const mergeMethod = isRecord(body) && typeof body.merge_method === 'string' ? body.merge_method.toLowerCase() : 'squash';
        const merged = store.mergePull(repo, pull, mergeMethod);
        if ('error' in merged) {
          sendError(ctx, merged.conflict === true ? 405 : 422, merged.error);
          return true;
        }
        sendJson(ctx, 200, { sha: merged.sha, merged: true, message: merged.message });
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    sendError(ctx, 404, 'Not Found');
    return true;
  }

  sendError(ctx, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL v4 and MCP.
// ---------------------------------------------------------------------------

async function handleGraphQL(ctx: Ctx): Promise<boolean> {
  if (!requireAuth(ctx)) return true;
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(await readBody(ctx));
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  // Batched operations: a JSON array answers an array, in order.
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'each batched entry needs a query string' }] };
      }
      const variables = isRecord(entry.variables) ? entry.variables : {};
      return executeGraphQL(ctx.store, entry.query, variables, typeof entry.operationName === 'string' ? entry.operationName : null);
    });
    sendJson(ctx, 200, results);
    return true;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    sendJson(ctx, 200, { data: null, errors: [{ message: 'a query string is required' }] });
    return true;
  }
  const variables = isRecord(body.variables) ? body.variables : {};
  const result = executeGraphQL(ctx.store, body.query, variables, typeof body.operationName === 'string' ? body.operationName : null);
  sendJson(ctx, 200, result);
  return true;
}

async function handleMcpEndpoint(ctx: Ctx): Promise<boolean> {
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!requireAuth(ctx)) return true;
  let raw: Buffer;
  try {
    raw = await readBody(ctx);
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(raw);
  } catch {
    // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (isRecord(body) && !('id' in body)) {
    // A notification: no JSON-RPC answer, just 202.
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.store.nextRequestId() });
    ctx.res.end();
    return true;
  }
  const outcome = handleMcp(ctx.store, body);
  sendJson(ctx, outcome.status, outcome.json);
  return true;
}

// ---------------------------------------------------------------------------
// Git smart HTTP.
// ---------------------------------------------------------------------------

function gitRepo(ctx: Ctx, owner: string, name: string): ReturnType<Store['getRepo']> {
  const clean = name.endsWith('.git') ? name.slice(0, -4) : name;
  return repoFor(ctx, owner, clean);
}

function v0Advertisement(ctx: Ctx, service: string, repo: NonNullable<ReturnType<Store['getRepo']>>): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main object-format=sha1 agent=git-forge/1.0'
      : 'symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack object-format=sha1 agent=git-forge/1.0';
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), encodeFlush()];
  const refs = ctx.store.listRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = ctx.store.defaultTip(repo);
    let first = true;
    const lines: string[] = [];
    if (headTip) lines.push(`${headTip} HEAD`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.ref}`);
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        if (target !== '') lines.push(`${target} ${ref.ref}^{}`);
      }
    }
    for (const line of lines) {
      if (first) {
        parts.push(encodePktLine(`${line}\0${caps}\n`));
        first = false;
      } else {
        parts.push(encodePktLine(`${line}\n`));
      }
    }
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('object-format=sha1\n'),
    encodeFlush(),
  ]);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(ctx: Ctx, repo: NonNullable<ReturnType<Store['getRepo']>>, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const tip = ctx.store.defaultTip(repo);
  if (tip) {
    if (matches('HEAD')) {
      const attr = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(encodePktLine(`${tip} HEAD${attr}\n`));
    }
    for (const ref of ctx.store.listRefs(repo)) {
      if (!matches(ref.ref)) continue;
      let line = `${ref.oid} ${ref.ref}`;
      if (args.peel) {
        // Annotated tags peel to the object they (transitively) point at,
        // carried on the ref's own line — not as a second line naming the
        // same ref, which a client reads as a duplicate ref without a peel.
        let peeled: string | null = null;
        let current = ref.oid;
        for (let hops = 0; hops < 8; hops += 1) {
          const obj = repo.objects.get(current);
          if (!obj || obj.type !== 'tag') break;
          const target = parseTag(obj.data).object;
          if (target === '') break;
          peeled = target;
          current = target;
        }
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      parts.push(encodePktLine(`${line}\n`));
    }
  } else if (args.unborn && matches('HEAD')) {
    parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

function fetchResponse(ctx: Ctx, repo: NonNullable<ReturnType<Store['getRepo']>>, wants: string[], haves: string[], shallow: string[], depth: number | undefined, done: boolean): Buffer {
  const selection = selectFetch(repo.objects, wants, haves, shallow, depth);
  const pack = writePack(selection.objects);
  // Protocol v2 (gitprotocol-v2): if the client finished negotiations by
  // sending "done", the acknowledgments section MUST be omitted. If it did
  // not send "done" (a fetch with haves, e.g. a shallow fetch from an
  // existing clone), the server MUST send the acknowledgments section —
  // ACK per common have (or NAK) plus "ready" — before the packfile, and
  // real git's client errors if the section is missing. The suite client
  // always sends "done", so it takes the no-acks path.
  const parts: Buffer[] = [];
  if (!done && haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (selection.acks.length > 0) {
      for (const ack of selection.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(encodePktLine('ready\n'));
    parts.push(encodeDelim());
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(encodeDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  // Sideband: band 1 + pack bytes, chunked to pkt-line size.
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

async function handleGit(ctx: Ctx, segs: string[]): Promise<boolean> {
  if (segs.length < 2) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!requireAuth(ctx)) return true;
  const owner = segs[0]!;
  const name = segs[1]!;
  const repo = gitRepo(ctx, owner, name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const action = segs[2];

  if (ctx.method === 'GET' && action === 'info' && segs[3] === 'refs') {
    const service = ctx.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(ctx, 400, 'service is required');
      return true;
    }
    const contentType = `application/x-${service}-advertisement`;
    if (service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '') === 'version=2') {
      sendRaw(ctx, 200, v2Advertisement(), contentType);
      return true;
    }
    sendRaw(ctx, 200, v0Advertisement(ctx, service, repo), contentType);
    return true;
  }

  if (ctx.method === 'POST' && action === 'git-upload-pack') {
    if ((ctx.req.headers['git-protocol'] ?? '') !== 'version=2') {
      sendError(ctx, 400, 'this forge speaks protocol v2 for upload-pack');
      return true;
    }
    let raw: Buffer;
    try {
      raw = await readBody(ctx);
    } catch {
      sendError(ctx, 400, 'Problems reading the request');
      return true;
    }
    let packets;
    try {
      packets = decodePktLines(raw).filter((packet) => packet.kind === 'data').map((packet) => (packet.kind === 'data' ? packet.data.toString('utf8') : ''));
    } catch {
      sendError(ctx, 400, 'malformed pkt-line stream');
      return true;
    }
    const commandLine = packets[0] ?? '';
    const commandMatch = /^command=(ls-refs|fetch)\n?$/.exec(commandLine.trim());
    if (!commandMatch) {
      sendError(ctx, 400, 'the first pkt-line must name a v2 command');
      return true;
    }
    const command = commandMatch[1]!;
    const args = packets.slice(1);
    if (command === 'ls-refs') {
      const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const arg of args) {
        const line = arg.replace(/\n$/, '');
        if (line === 'peel') parsed.peel = true;
        else if (line === 'symrefs') parsed.symrefs = true;
        else if (line === 'unborn') parsed.unborn = true;
        else if (line.startsWith('ref-prefix ')) parsed.prefixes.push(line.slice('ref-prefix '.length));
      }
      sendRaw(ctx, 200, lsRefsResponse(ctx, repo, parsed), 'application/x-git-upload-pack-result');
      return true;
    }
    // fetch
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    let done = false;
    for (const arg of args) {
      const line = arg.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line === 'done') done = true;
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    if (wants.length === 0) {
      sendError(ctx, 400, 'fetch needs at least one want');
      return true;
    }
    sendRaw(ctx, 200, fetchResponse(ctx, repo, wants, haves, shallow, depth, done), 'application/x-git-upload-pack-result');
    return true;
  }

  if (ctx.method === 'POST' && action === 'git-receive-pack') {
    let raw: Buffer;
    try {
      raw = await readBody(ctx);
    } catch {
      sendError(ctx, 400, 'Problems reading the request');
      return true;
    }
    let packets;
    let consumed = 0;
    try {
      const parsed = parsePktStream(raw);
      packets = parsed.packets;
      consumed = parsed.consumed;
    } catch {
      sendError(ctx, 400, 'malformed pkt-line stream');
      return true;
    }
    interface Command {
      oldOid: string;
      newOid: string;
      ref: string;
    }
    const commands: Command[] = [];
    let bad = false;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.data.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul !== -1) text = text.slice(0, nul);
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(text);
      if (!match) {
        bad = true;
        break;
      }
      commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
    }
    if (bad || commands.length === 0) {
      sendError(ctx, 400, 'malformed receive-pack commands');
      return true;
    }
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    const packBytes = raw.subarray(consumed);
    const reportLines: string[] = [];
    if (needsPack) {
      if (packBytes.length < 32) {
        reportLines.push('unpack error missing packfile');
        for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error`);
        return sendReceiveReport(ctx, reportLines);
      }
      let unpacked: Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>;
      try {
        unpacked = readPack(packBytes, (oid) => repo.objects.get(oid));
      } catch (err) {
        reportLines.push(`unpack error ${err instanceof Error ? err.message : String(err)}`);
        for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error`);
        return sendReceiveReport(ctx, reportLines);
      }
      for (const [oid, obj] of unpacked) repo.objects.set(oid, obj);
      reportLines.push('unpack ok');
    } else {
      reportLines.push('unpack ok');
    }
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) reportLines.push(`ng ${command.ref} remote ref does not exist`);
        else if (current !== command.oldOid) reportLines.push(`ng ${command.ref} failed to lock`);
        else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      const obj = repo.objects.get(command.newOid);
      if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
        reportLines.push(`ng ${command.ref} invalid object`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== ZERO_OID) reportLines.push(`ng ${command.ref} already exists`);
        else {
          ctx.store.setRef(repo, command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (current === ZERO_OID) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} failed to lock`);
      } else if (command.newOid === command.oldOid) {
        reportLines.push(`ok ${command.ref}`);
      } else if (isAncestor(repo.objects, command.oldOid, command.newOid)) {
        ctx.store.setRef(repo, command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      } else {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      }
    }
    return sendReceiveReport(ctx, reportLines);
  }

  sendError(ctx, 404, 'Not Found');
  return true;
}

function sendReceiveReport(ctx: Ctx, lines: string[]): boolean {
  const stream = Buffer.concat([...lines.map((line) => encodePktLine(`${line}\n`)), encodeFlush()]);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < stream.length; offset += 65515) {
    const chunk = stream.subarray(offset, Math.min(stream.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(encodeFlush());
  sendRaw(ctx, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
  return true;
}

// ---------------------------------------------------------------------------
// Server.
// ---------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const ctx: Ctx = {
        store,
        req,
        res,
        method: req.method ?? 'GET',
        path: '/',
        query: new URLSearchParams(),
        host: req.headers.host ?? '127.0.0.1',
      };
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        ctx.path = url.pathname.replace(/\/+$/, '') || '/';
        ctx.query = url.searchParams;
      } catch {
        sendError(ctx, 400, 'bad request URL');
        return;
      }
      try {
        if (ctx.method === 'GET' && ctx.path === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        const segs = segments(ctx.path);
        if (segs === null) {
          sendError(ctx, 400, 'bad request path');
          return;
        }
        if (segs[0] === 'api' && segs[1] === 'v3') {
          await handleRest(ctx, segs.slice(2));
          return;
        }
        if (segs[0] === 'api' && segs[1] === 'graphql' && segs.length === 2) {
          await handleGraphQL(ctx);
          return;
        }
        if (segs[0] === 'mcp' && segs.length === 1) {
          await handleMcpEndpoint(ctx);
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segs.length >= 2 && segs[1]!.endsWith('.git')) {
          await handleGit(ctx, segs);
          return;
        }
        sendError(ctx, 404, 'Not Found');
      } catch (err) {
        // A handler must never take the server down with it.
        try {
          if (!res.headersSent) sendError(ctx, 500, err instanceof Error ? err.message : String(err));
          else res.end();
        } catch {
          // The socket is already gone.
        }
      }
    })();
  });
}
