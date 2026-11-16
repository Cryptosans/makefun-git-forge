// store.ts — the forge's in-memory state: users, repositories, git objects,
// issues, pull requests, labels and comments. No disk, no clock reads: every
// timestamp comes from a logical clock (a fixed base plus one second per
// mutation), so a replay of the same requests produces the same state.

import {
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTreeFromMap,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  threeWayMerge,
  countLines,
  type GitObject,
  type ObjType,
} from './gitcore.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const ORG = 'faint-meadow-org';

/** The scenario's day one: every generated timestamp starts here. */
export const BASE_EPOCH = 1735689600;

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
}

export type GlobalKind = 'repo' | 'issue' | 'pull' | 'comment';

/** Opaque Relay-style global ids: stable across reads, never the plain number. */
export function globalId(kind: GlobalKind, repoId: number, number: number, extra = 0): string {
  if (kind === 'repo') return `R${repoId}`;
  if (kind === 'issue') return `I${repoId}_${number}`;
  if (kind === 'pull') return `P${repoId}_${number}`;
  return `C${repoId}_${number}_${extra}`;
}

/** Decode a global id back to what it names, or null. */
export function parseGlobalId(id: string): { kind: GlobalKind; repoId: number; number: number; extra: number } | null {
  let match = /^R(\d+)$/.exec(id);
  if (match) return { kind: 'repo', repoId: Number(match[1]), number: 0, extra: 0 };
  match = /^I(\d+)_(\d+)$/.exec(id);
  if (match) return { kind: 'issue', repoId: Number(match[1]), number: Number(match[2]), extra: 0 };
  match = /^P(\d+)_(\d+)$/.exec(id);
  if (match) return { kind: 'pull', repoId: Number(match[1]), number: Number(match[2]), extra: 0 };
  match = /^C(\d+)_(\d+)_(\d+)$/.exec(id);
  if (match) return { kind: 'comment', repoId: Number(match[1]), number: Number(match[2]), extra: Number(match[3]) };
  return null;
}

export class Store {
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  private nextRepoId = 5000;
  private nextObjectId = 1;
  private nextLabelId = 1;
  private epoch = BASE_EPOCH;
  private seq = 0;
  private requestSeq = 0;

  /** One logical second per mutation; returns [epoch seconds, ISO string]. */
  tick(): [number, string] {
    this.epoch += 1;
    this.seq += 1;
    return [this.epoch, new Date(this.epoch * 1000).toISOString()];
  }

  /** Monotonic sequence for ordering (created_at ties break by number anyway). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Deterministic request ids for X-GitHub-Request-Id. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${String(this.requestSeq).padStart(8, '0')}`;
  }

  private iso(epoch: number): string {
    return new Date(epoch * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const [epoch, at] = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdAt: at,
      updatedAt: at,
      pushedAt: at,
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    void epoch;
    this.repos.set(this.repoKey(repo.owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.id);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -------------------------------------------------------------------------
  // Git: refs and objects.
  // -------------------------------------------------------------------------

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    const [, at] = this.tick();
    repo.pushedAt = at;
    repo.updatedAt = at;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  listRefs(repo: Repo): Array<{ ref: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([ref, oid]) => ({ ref, oid }))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1));
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Resolve a ref name, branch name or raw oid to a commit id (tags unwrap). */
  resolveToCommit(repo: Repo, ref: string): string | null {
    let oid: string | undefined;
    if (isOid(ref)) oid = ref;
    else if (ref.startsWith('refs/')) oid = repo.refs.get(ref);
    else oid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    if (!oid) return null;
    const obj = repo.objects.get(oid);
    if (!obj) return null;
    if (obj.type === 'tag') return parseTag(obj.data).object;
    if (obj.type === 'commit') return oid;
    return null;
  }

  /** Commits reachable from a ref, newest first (children before parents). */
  listCommits(repo: Repo, fromRef: string, limit = 30): Array<{ sha: string; message: string; author: string; committer: string; epoch: number; parents: string[] }> {
    const tip = this.resolveToCommit(repo, fromRef);
    if (!tip) return [];
    const out: Array<{ sha: string; message: string; author: string; committer: string; epoch: number; parents: string[] }> = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = parseCommit(obj.data);
      const authorEpoch = Number(/(\d+) \+0000/.exec(parsed.author)?.[1] ?? BASE_EPOCH);
      out.push({ sha: oid, message: parsed.message, author: parsed.author, committer: parsed.committer, epoch: authorEpoch, parents: parsed.parents });
      for (const parent of parsed.parents) queue.push(parent);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Contents: commit a file write or delete onto a branch.
  // -------------------------------------------------------------------------

  /**
   * Commit `change` onto `branch` (creating the branch from the default tip
   * when it does not exist yet, and creating the repository's first commit
   * when the repo is unborn). Returns the new commit id.
   */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): string {
    const [epoch] = this.tick();
    let tip = this.branchTip(repo, branch);
    if (!tip) {
      const defaultTip = this.defaultTip(repo);
      if (defaultTip) {
        tip = defaultTip;
        repo.refs.set(`refs/heads/${branch}`, tip);
      }
    }
    const flat = tip ? flattenTree(repo.objects, parseCommit(repo.objects.get(tip)!.data).tree) : new Map<string, { oid: string; mode: string }>();
    if (content === null) {
      flat.delete(path);
    } else {
      const blobOid = hashObject('blob', content);
      repo.objects.set(blobOid, { type: 'blob', data: content });
      flat.set(path, { oid: blobOid, mode: '100644' });
    }
    const treeOid = buildTreeFromMap(repo.objects, flat);
    const parents = tip ? [tip] : [];
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      committerName: VIEWER.name,
      committerEmail: VIEWER.email,
      epoch,
      message,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    const [, at] = this.tick();
    repo.updatedAt = at;
    repo.pushedAt = at;
    return commitOid;
  }

  /** Read a file blob at a ref, or null when the path is not a file there. */
  readFileAt(repo: Repo, ref: string, path: string): { oid: string; data: Buffer } | null {
    const tip = this.resolveToCommit(repo, ref);
    if (!tip) return null;
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const flat = flattenTree(repo.objects, tree);
    const entry = flat.get(path);
    if (!entry) return null;
    const obj = repo.objects.get(entry.oid);
    if (!obj || obj.type !== 'blob') return null;
    return { oid: entry.oid, data: obj.data };
  }

  /** List a directory at a ref: [{type, name, path, sha, size}]. Null when missing. */
  listDirAt(repo: Repo, ref: string, path: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }> | null {
    const tip = this.resolveToCommit(repo, ref);
    if (!tip) return null;
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const flat = flattenTree(repo.objects, tree);
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
    for (const [full, file] of flat) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const obj = repo.objects.get(file.oid);
        seen.set(rest, { type: 'file', name: rest, path: full, sha: file.oid, size: obj ? obj.data.length : 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!seen.has(dir)) {
          // The subtree id: walk the tree to find it.
          let dirOid = '';
          const walk = (treeOid: string, parts: string[]): void => {
            const obj = repo.objects.get(treeOid);
            if (!obj || obj.type !== 'tree') return;
            for (const entry of parseTree(obj.data)) {
              if (entry.name === parts[0]) {
                if (parts.length === 1) dirOid = entry.oid;
                else if (entry.mode === '40000') walk(entry.oid, parts.slice(1));
              }
            }
          };
          walk(tree, path === '' ? [dir] : [...path.split('/'), dir]);
          seen.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: dirOid, size: 0 });
        }
      }
    }
    // Git tracks no empty directories: a non-root path with no files under
    // it does not exist, so it is a 404 rather than an empty listing.
    if (path !== '' && seen.size === 0) return null;
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  // -------------------------------------------------------------------------
  // Labels, issues, pull requests.
  // -------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const label: Label = { id: this.nextLabelId++, name, color: color.replace(/^#/, '').toLowerCase() || 'ffffff', description };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const [, at] = this.tick();
    const issue: Issue = {
      id: this.nextObjectId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: VIEWER.login,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      createdSeq: this.seq,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, state: 'open' | 'closed' | 'all', sort: 'created' | 'updated', direction: 'asc' | 'desc'): Issue[] {
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    list = [...list].sort((a, b) => {
      const key = sort === 'updated' ? 'updatedAt' : 'createdAt';
      const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.number - b.number;
      return direction === 'asc' ? cmp : -cmp;
    });
    return list;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const [, at] = this.tick();
    const comment: Comment = { id: this.nextObjectId++, body, user: VIEWER.login, createdAt: at, createdSeq: this.seq };
    issue.comments.push(comment);
    issue.updatedAt = at;
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headTip = this.branchTip(repo, headRef);
    if (!headTip) return { error: `head branch ${headRef} does not exist` };
    const baseTip = this.branchTip(repo, baseRef);
    if (!baseTip) return { error: `base branch ${baseRef} does not exist` };
    if (repo.pulls.some((pull) => pull.headRef === headRef && pull.baseRef === baseRef && pull.state === 'open')) {
      return { error: 'a pull request already exists for this head and base' };
    }
    const [, at] = this.tick();
    const pull: Pull = {
      id: this.nextObjectId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      headRef,
      headSha: headTip,
      baseRef,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: VIEWER.login,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      createdSeq: this.seq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): Pull[] {
    return repo.pulls.filter((pull) => state === 'all' || pull.state === state).sort((a, b) => b.createdSeq - a.createdSeq);
  }

  /** The changed files of a pull request: diff of merge-base against the head tip. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.resolveToCommit(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveToCommit(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo.objects, baseTip, headTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const changes = diffTrees(repo.objects, baseTree, headTree);
    return changes.map((change) => {
      const oldData = change.oldOid ? repo.objects.get(change.oldOid)?.data : undefined;
      const newData = change.newOid ? repo.objects.get(change.newOid)?.data : undefined;
      let additions = 0;
      let deletions = 0;
      if (change.status === 'added') additions = newData ? countLines(newData) : 0;
      else if (change.status === 'deleted') deletions = oldData ? countLines(oldData) : 0;
      else {
        additions = newData ? countLines(newData) : 0;
        deletions = oldData ? countLines(oldData) : 0;
      }
      if (change.status !== 'deleted' && additions === 0) additions = 1;
      return {
        filename: change.path,
        status: change.status === 'deleted' ? 'removed' : change.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
  }

  /** Whether a pull request merges cleanly right now (MERGEABLE vs CONFLICTING). */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (!headTip || !baseTip) return 'UNKNOWN';
    const base = mergeBase(repo.objects, baseTip, headTip);
    if (base === null) return 'UNKNOWN';
    const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const oursTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const theirsTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const { conflicts } = threeWayMerge(repo.objects, baseTree, oursTree, theirsTree);
    return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * id, or an error string ('conflict' for a 405, anything else for a 422).
   */
  mergePull(repo: Repo, pull: Pull, method: string): { sha: string; message: string } | { error: string; conflict?: boolean } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    if (method !== '' && method !== 'squash' && method !== 'merge' && method !== 'rebase') return { error: `unsupported merge method ${method}` };
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (!headTip || !baseTip) return { error: 'head or base branch is missing' };
    const base = mergeBase(repo.objects, baseTip, headTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const oursTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const theirsTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const { merged, conflicts } = threeWayMerge(repo.objects, baseTree, oursTree, theirsTree);
    if (conflicts.length > 0) return { error: `merge conflict in ${conflicts.join(', ')}`, conflict: true };
    const [epoch, at] = this.tick();
    const treeOid = buildTreeFromMap(repo.objects, merged);
    const message = `${pull.title} (#${pull.number})`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      committerName: VIEWER.name,
      committerEmail: VIEWER.email,
      epoch,
      message,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.merged = true;
    pull.mergedAt = at;
    pull.mergeCommitSha = commitOid;
    pull.state = 'closed';
    pull.closedAt = at;
    pull.updatedAt = at;
    repo.updatedAt = at;
    repo.pushedAt = at;
    return { sha: commitOid, message };
  }

  // -------------------------------------------------------------------------
  // REST view shapes (extra fields are allowed by the suite's shape checker).
  // -------------------------------------------------------------------------

  repoView(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: globalId('repo', repo.id, 0),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER.id, node_id: `U${VIEWER.id}`, type: 'User', site_admin: false },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.pushedAt,
      clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
      git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
      ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      has_pages: false,
      has_downloads: true,
      has_discussions: false,
      fork: false,
      archived: false,
      disabled: false,
      visibility: repo.private ? 'private' : 'public',
      license: null,
      topics: [],
      language: null,
      size: 0,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      subscribers_count: 0,
    };
  }

  issueView(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: globalId('issue', repo.id, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      user: { login: issue.user, id: VIEWER.id, type: 'User' },
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { id: label?.id ?? 0, name, color: label?.color ?? 'ffffff', description: label?.description ?? '' };
      }),
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      comments: issue.comments.length,
      comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    };
  }

  commentView(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: globalId('comment', repo.id, issue.number, comment.id),
      body: comment.body,
      user: { login: comment.user, id: VIEWER.id, type: 'User' },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
      issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  pullView(repo: Repo, pull: Pull): Record<string, unknown> {
    const files = this.pullFiles(repo, pull);
    return {
      id: pull.id,
      node_id: globalId('pull', repo.id, pull.number),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      user: { login: pull.user, id: VIEWER.id, type: 'User' },
      labels: [],
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, id: VIEWER.id, type: 'User' } },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, id: VIEWER.id, type: 'User' } },
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      mergeable: this.pullMergeable(repo, pull) === 'MERGEABLE',
      mergeable_state: this.pullMergeable(repo, pull) === 'MERGEABLE' ? 'clean' : this.pullMergeable(repo, pull) === 'CONFLICTING' ? 'dirty' : 'unknown',
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.closedAt,
      commits: 1,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      changed_files: files.length,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }
}

// Re-export the object helpers the HTTP layer uses directly.
export { ZERO_OID, hashObject, parseCommit, parseTree, parseTag };
export type { GitObject, ObjType };
