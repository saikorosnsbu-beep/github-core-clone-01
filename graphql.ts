// A compact GraphQL executor covering exactly the document shapes the forge's
// clients send: named operations, variables, aliases, inline fragments, input
// objects, enum lists, introspection (__type), mutations, and JSON batching.

import type { Store, RepoRec, IssueRec, PullRec } from "./store.ts";
import { nodeId, parseNodeId, addressRepo } from "./store.ts";
import {
  HttpError,
  branchTip,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
  computeMergeable,
  pullFiles,
} from "./domain.ts";

// ---------------------------------------------------------------- tokenizer

type Tok =
  | { kind: "name"; value: string }
  | { kind: "string"; value: string }
  | { kind: "int"; value: number }
  | { kind: "punct"; value: string }
  | { kind: "spread" };

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === ",") {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (input.startsWith("...", i)) {
      toks.push({ kind: "spread" });
      i += 3;
      continue;
    }
    if ("{}():$![]=@|".includes(ch)) {
      toks.push({ kind: "punct", value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        toks.push({ kind: "string", value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = "";
      while (j < input.length && input[j] !== '"') {
        if (input[j] === "\\") {
          value += input[j + 1];
          j += 2;
        } else {
          value += input[j];
          j++;
        }
      }
      toks.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j++;
      toks.push({ kind: "int", value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j])) j++;
      toks.push({ kind: "name", value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return toks;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: "var"; name: string }
  | { kind: "string"; value: string }
  | { kind: "int"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "enum"; value: string }
  | { kind: "null" }
  | { kind: "list"; items: Value[] }
  | { kind: "object"; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: "field"; field: FieldNode }
  | { kind: "fragment"; typeCondition: string; selection: SelectionNode[] };

interface Operation {
  type: "query" | "mutation";
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  next(): Tok {
    const tok = this.toks[this.pos++];
    if (!tok) throw new Error("unexpected end of document");
    return tok;
  }
  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== "punct" || tok.value !== value) throw new Error(`expected "${value}"`);
  }
  skipPunct(value: string): boolean {
    const tok = this.peek();
    if (tok && tok.kind === "punct" && tok.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }
  expectName(): string {
    const tok = this.next();
    if (tok.kind !== "name") throw new Error("expected a name");
    return tok.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.toks.length) ops.push(this.parseOperation());
    return ops;
  }

  parseOperation(): Operation {
    const tok = this.peek();
    if (tok && tok.kind === "punct" && tok.value === "{") {
      return { type: "query", name: null, selection: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== "query" && keyword !== "mutation" && keyword !== "subscription") {
      throw new Error(`unsupported definition "${keyword}"`);
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName && maybeName.kind === "name") name = this.expectName();
    if (this.skipPunct("(")) {
      // variable definitions: skip to the matching close paren
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.kind === "punct" && t.value === "(") depth++;
        else if (t.kind === "punct" && t.value === ")") depth--;
      }
    }
    // directives (none in the fixed documents, but skip if present)
    while (this.peek()?.kind === "punct" && this.peek()?.value === "@") {
      this.next();
      this.expectName();
      if (this.skipPunct("(")) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === "punct" && t.value === "(") depth++;
          else if (t.kind === "punct" && t.value === ")") depth--;
        }
      }
    }
    return { type: keyword === "mutation" ? "mutation" : "query", name, selection: this.parseSelectionSet() };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const selections: SelectionNode[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok && tok.kind === "punct" && tok.value === "}") {
        this.next();
        break;
      }
      if (tok && tok.kind === "spread") {
        this.next();
        const on = this.expectName();
        if (on !== "on") throw new Error("named fragments are not supported");
        const typeCondition = this.expectName();
        selections.push({ kind: "fragment", typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      selections.push({ kind: "field", field: this.parseField() });
    }
    return selections;
  }

  parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(":")) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode["args"] = [];
    if (this.skipPunct("(")) {
      for (;;) {
        if (this.skipPunct(")")) break;
        const argName = this.expectName();
        this.expectPunct(":");
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selection: SelectionNode[] | null = null;
    const tok = this.peek();
    if (tok && tok.kind === "punct" && tok.value === "{") selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  parseValue(): Value {
    const tok = this.next();
    if (tok.kind === "string") return { kind: "string", value: tok.value };
    if (tok.kind === "int") return { kind: "int", value: tok.value };
    if (tok.kind === "punct" && tok.value === "$") return { kind: "var", name: this.expectName() };
    if (tok.kind === "punct" && tok.value === "[") {
      const items: Value[] = [];
      for (;;) {
        const next = this.peek();
        if (next && next.kind === "punct" && next.value === "]") {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return { kind: "list", items };
    }
    if (tok.kind === "punct" && tok.value === "{") {
      const fields: Array<{ name: string; value: Value }> = [];
      for (;;) {
        const next = this.peek();
        if (next && next.kind === "punct" && next.value === "}") {
          this.next();
          break;
        }
        const fieldName = this.expectName();
        this.expectPunct(":");
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      return { kind: "object", fields };
    }
    if (tok.kind === "name") {
      if (tok.value === "true") return { kind: "bool", value: true };
      if (tok.value === "false") return { kind: "bool", value: false };
      if (tok.value === "null") return { kind: "null" };
      return { kind: "enum", value: tok.value };
    }
    throw new Error("unexpected value token");
  }
}

function resolveValue(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case "var":
      return vars[value.name] ?? null;
    case "string":
    case "int":
    case "bool":
    case "enum":
      return value.value;
    case "null":
      return null;
    case "list":
      return value.items.map((item) => resolveValue(item, vars));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Source = Record<string, unknown> & { __type: string };

function src(type: string, data: Record<string, unknown>): Source {
  return { __type: type, ...data };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ["viewer", "repository", "node", "__type", "__schema"],
  Mutation: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
  User: ["login", "id", "name"],
  Repository: [
    "id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission",
    "hasIssuesEnabled", "issue", "issues", "pullRequest", "pullRequests",
  ],
  Ref: ["name", "target"],
  Issue: ["id", "number", "title", "state", "body", "repository"],
  PullRequest: [
    "id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "files", "repository",
  ],
  IssueConnection: ["nodes", "pageInfo", "totalCount", "edges"],
  PullRequestConnection: ["nodes", "pageInfo", "totalCount", "edges"],
  PullRequestFileConnection: ["nodes", "pageInfo", "totalCount"],
  PageInfo: ["hasNextPage", "hasPreviousPage", "endCursor", "startCursor"],
  PullRequestChangedFile: ["path"],
  Comment: ["id", "body"],
  CreateIssuePayload: ["issue"],
  CloseIssuePayload: ["issue"],
  CreatePullRequestPayload: ["pullRequest"],
  MergePullRequestPayload: ["pullRequest"],
  AddCommentPayload: ["commentEdge"],
  CommentEdge: ["node"],
  __Type: ["name", "kind", "fields", "enumValues"],
  __Field: ["name", "description"],
  __EnumValue: ["name", "description"],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION", "CODE"],
  IssueState: ["OPEN", "CLOSED"],
  PullRequestState: ["OPEN", "CLOSED", "MERGED"],
  MergeableState: ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
  OrderDirection: ["ASC", "DESC"],
};

function repoSource(ctx: Ctx, repo: RepoRec): Source {
  return src("Repository", { repo });
}

function issueSource(repo: RepoRec, issue: IssueRec): Source {
  return src("Issue", { repo, issue });
}

function pullSource(repo: RepoRec, pull: PullRec): Source {
  return src("PullRequest", { repo, pull });
}

function findRepoByDbId(store: Store, dbId: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function findIssueByDbId(store: Store, dbId: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === dbId) return { repo, issue };
  }
  return null;
}

function findPullByDbId(store: Store, dbId: number): { repo: RepoRec; pull: PullRec } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === dbId) return { repo, pull };
  }
  return null;
}

function connection(items: Source[], first: number | null, after: string | null, type: string): Source {
  let startIndex = 0;
  if (after) {
    const decoded = Buffer.from(after, "base64").toString("utf8");
    const match = /^cursor:(\d+)$/.exec(decoded);
    if (match) startIndex = Number(match[1]) + 1;
  }
  const sliced = first !== null && first !== undefined ? items.slice(startIndex, startIndex + first) : items.slice(startIndex);
  const hasNext = startIndex + sliced.length < items.length;
  const endCursor = sliced.length
    ? Buffer.from(`cursor:${startIndex + sliced.length - 1}`, "utf8").toString("base64")
    : after;
  return src(type, {
    nodesRaw: sliced,
    pageInfoRaw: {
      hasNextPage: hasNext,
      hasPreviousPage: startIndex > 0,
      endCursor: endCursor ?? null,
      startCursor: sliced.length ? Buffer.from(`cursor:${startIndex}`, "utf8").toString("base64") : null,
    },
    totalCount: items.length,
  });
}

type Resolver = (ctx: Ctx, source: Source, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => src("User", { login: ctx.store.viewerLogin() }),
    repository: (ctx, _s, args) => {
      const repo = addressRepo(ctx.store, String(args.owner ?? ""), String(args.name ?? ""));
      return repo ? repoSource(ctx, repo) : null;
    },
    node: (ctx, _s, args) => {
      const parsed = parseNodeId(String(args.id ?? ""));
      if (!parsed) return null;
      if (parsed.type === "Repository") {
        const repo = findRepoByDbId(ctx.store, parsed.dbId);
        return repo ? repoSource(ctx, repo) : null;
      }
      if (parsed.type === "Issue") {
        const found = findIssueByDbId(ctx.store, parsed.dbId);
        return found ? issueSource(found.repo, found.issue) : null;
      }
      if (parsed.type === "PullRequest") {
        const found = findPullByDbId(ctx.store, parsed.dbId);
        return found ? pullSource(found.repo, found.pull) : null;
      }
      return null;
    },
    __type: (_ctx, _s, args) => src("__Type", { typeName: String(args.name ?? "") }),
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseNodeId(String(input.repositoryId ?? ""));
      const repo = parsed ? findRepoByDbId(ctx.store, parsed.dbId) : null;
      if (!repo) throw new Error("repository not found");
      const issue = createIssueRecord(ctx.store, repo, {
        title: String(input.title ?? ""),
        body: input.body === null || input.body === undefined ? "" : String(input.body),
      });
      return src("CreateIssuePayload", { issue: issueSource(repo, issue) });
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseNodeId(String(input.issueId ?? ""));
      const found = parsed ? findIssueByDbId(ctx.store, parsed.dbId) : null;
      if (!found) throw new Error("issue not found");
      found.issue.state = "closed";
      return src("CloseIssuePayload", { issue: issueSource(found.repo, found.issue) });
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseNodeId(String(input.repositoryId ?? ""));
      const repo = parsed ? findRepoByDbId(ctx.store, parsed.dbId) : null;
      if (!repo) throw new Error("repository not found");
      try {
        const pull = createPullRecord(ctx.store, repo, {
          title: String(input.title ?? ""),
          body: input.body === null || input.body === undefined ? "" : String(input.body),
          head: String(input.headRefName ?? ""),
          base: String(input.baseRefName ?? ""),
        });
        return src("CreatePullRequestPayload", { pullRequest: pullSource(repo, pull) });
      } catch (error) {
        if (error instanceof HttpError) throw new Error(error.message);
        throw error;
      }
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseNodeId(String(input.pullRequestId ?? ""));
      const found = parsed ? findPullByDbId(ctx.store, parsed.dbId) : null;
      if (!found) throw new Error("pull request not found");
      const methodRaw = String(input.mergeMethod ?? "MERGE").toLowerCase();
      try {
        mergePullRecord(ctx.store, found.repo, found.pull, methodRaw);
      } catch (error) {
        if (error instanceof HttpError) throw new Error(error.message);
        throw error;
      }
      return src("MergePullRequestPayload", { pullRequest: pullSource(found.repo, found.pull) });
    },
    addComment: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseNodeId(String(input.subjectId ?? ""));
      if (!parsed) throw new Error("subject not found");
      const body = String(input.body ?? "");
      let repo: RepoRec | null = null;
      let number: number | null = null;
      if (parsed.type === "Issue") {
        const found = findIssueByDbId(ctx.store, parsed.dbId);
        if (found) {
          repo = found.repo;
          number = found.issue.number;
        }
      } else if (parsed.type === "PullRequest") {
        const found = findPullByDbId(ctx.store, parsed.dbId);
        if (found) {
          repo = found.repo;
          number = found.pull.number;
        }
      }
      if (!repo || number === null) throw new Error("subject not found");
      const comment = { id: ++ctx.store.commentSeq, body, tick: ctx.store.tick() };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return src("AddCommentPayload", {
        commentEdge: src("CommentEdge", { node: src("Comment", { comment }) }),
      });
    },
  },
  User: {
    login: (_ctx, s) => s.login,
    id: (ctx) => nodeId("User", 1),
    name: (ctx, s) => s.login,
  },
  Repository: {
    id: (_ctx, s) => nodeId("Repository", (s.repo as RepoRec).dbId),
    databaseId: (_ctx, s) => (s.repo as RepoRec).dbId,
    name: (_ctx, s) => (s.repo as RepoRec).name,
    nameWithOwner: (ctx, s) => {
      const repo = s.repo as RepoRec;
      return `${repo.owner ?? ctx.store.viewerLogin()}/${repo.name}`;
    },
    owner: (ctx, s) => {
      const repo = s.repo as RepoRec;
      return src("User", { login: repo.owner ?? ctx.store.viewerLogin() });
    },
    defaultBranchRef: (_ctx, s) => {
      const repo = s.repo as RepoRec;
      const tip = branchTip(repo, repo.defaultBranch);
      return tip ? src("Ref", { name: repo.defaultBranch }) : null;
    },
    viewerPermission: () => "ADMIN",
    hasIssuesEnabled: () => true,
    issue: (_ctx, s, args) => {
      const repo = s.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueSource(repo, issue) : null;
    },
    issues: (_ctx, s, args) => {
      const repo = s.repo as RepoRec;
      let items = [...repo.issues.values()];
      const states = args.states as string[] | null;
      if (Array.isArray(states) && states.length) {
        const wanted = new Set(states.map((x) => String(x).toLowerCase()));
        items = items.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? "ASC").toUpperCase();
      items.sort((a, b) => a.number - b.number);
      if (direction === "DESC") items.reverse();
      // Ties and equal timestamps break by number in the sort direction (gh behaviour
      // the checks rely on: CREATED_AT DESC lists newest/highest number first).
      const first = args.first === null || args.first === undefined ? null : Number(args.first);
      const after = args.after === null || args.after === undefined ? null : String(args.after);
      return connection(items.map((issue) => issueSource(repo, issue)), first, after, "IssueConnection");
    },
    pullRequest: (_ctx, s, args) => {
      const repo = s.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullSource(repo, pull) : null;
    },
    pullRequests: (_ctx, s, args) => {
      const repo = s.repo as RepoRec;
      const items = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      const first = args.first === null || args.first === undefined ? null : Number(args.first);
      const after = args.after === null || args.after === undefined ? null : String(args.after);
      return connection(items.map((pull) => pullSource(repo, pull)), first, after, "PullRequestConnection");
    },
  },
  Ref: {
    name: (_ctx, s) => s.name,
    target: (_ctx, s) => s.name,
  },
  Issue: {
    id: (_ctx, s) => nodeId("Issue", (s.issue as IssueRec).id),
    number: (_ctx, s) => (s.issue as IssueRec).number,
    title: (_ctx, s) => (s.issue as IssueRec).title,
    state: (_ctx, s) => ((s.issue as IssueRec).state === "open" ? "OPEN" : "CLOSED"),
    body: (_ctx, s) => (s.issue as IssueRec).body ?? "",
    repository: (ctx, s) => repoSource(ctx, s.repo as RepoRec),
  },
  PullRequest: {
    id: (_ctx, s) => nodeId("PullRequest", (s.pull as PullRec).id),
    number: (_ctx, s) => (s.pull as PullRec).number,
    title: (_ctx, s) => (s.pull as PullRec).title,
    body: (_ctx, s) => (s.pull as PullRec).body ?? "",
    state: (_ctx, s) => {
      const pull = s.pull as PullRec;
      return pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED";
    },
    merged: (_ctx, s) => (s.pull as PullRec).merged,
    mergeable: (_ctx, s) => {
      const pull = s.pull as PullRec;
      if (pull.state !== "open") return "UNKNOWN";
      return computeMergeable(s.repo as RepoRec, pull) ? "MERGEABLE" : "CONFLICTING";
    },
    headRefName: (_ctx, s) => (s.pull as PullRec).head,
    baseRefName: (_ctx, s) => (s.pull as PullRec).base,
    files: (_ctx, s, args) => {
      const repo = s.repo as RepoRec;
      const pull = s.pull as PullRec;
      const items = pullFiles(repo, pull).map((file) => src("PullRequestChangedFile", { path: file.filename }));
      const first = args.first === null || args.first === undefined ? null : Number(args.first);
      return connection(items, first, null, "PullRequestFileConnection");
    },
    repository: (ctx, s) => repoSource(ctx, s.repo as RepoRec),
  },
  IssueConnection: {
    nodes: (_ctx, s) => s.nodesRaw,
    pageInfo: (_ctx, s) => src("PageInfo", { ...(s.pageInfoRaw as Record<string, unknown>) }),
    totalCount: (_ctx, s) => s.totalCount,
    edges: (_ctx, s) =>
      ((s.nodesRaw as Source[]) ?? []).map((node) => src("Edge", { node, cursor: "" })),
  },
  PullRequestConnection: {
    nodes: (_ctx, s) => s.nodesRaw,
    pageInfo: (_ctx, s) => src("PageInfo", { ...(s.pageInfoRaw as Record<string, unknown>) }),
    totalCount: (_ctx, s) => s.totalCount,
    edges: (_ctx, s) =>
      ((s.nodesRaw as Source[]) ?? []).map((node) => src("Edge", { node, cursor: "" })),
  },
  PullRequestFileConnection: {
    nodes: (_ctx, s) => s.nodesRaw,
    pageInfo: (_ctx, s) => src("PageInfo", { ...(s.pageInfoRaw as Record<string, unknown>) }),
    totalCount: (_ctx, s) => s.totalCount,
  },
  PageInfo: {
    hasNextPage: (_ctx, s) => s.hasNextPage,
    hasPreviousPage: (_ctx, s) => s.hasPreviousPage,
    endCursor: (_ctx, s) => s.endCursor,
    startCursor: (_ctx, s) => s.startCursor,
  },
  PullRequestChangedFile: {
    path: (_ctx, s) => s.path,
  },
  Comment: {
    id: (_ctx, s) => nodeId("IssueComment", (s.comment as { id: number }).id),
    body: (_ctx, s) => (s.comment as { body: string }).body,
  },
  CreateIssuePayload: { issue: (_ctx, s) => s.issue },
  CloseIssuePayload: { issue: (_ctx, s) => s.issue },
  CreatePullRequestPayload: { pullRequest: (_ctx, s) => s.pullRequest },
  MergePullRequestPayload: { pullRequest: (_ctx, s) => s.pullRequest },
  AddCommentPayload: { commentEdge: (_ctx, s) => s.commentEdge },
  CommentEdge: { node: (_ctx, s) => s.node },
  Edge: {
    node: (_ctx, s) => s.node,
    cursor: (_ctx, s) => s.cursor,
  },
  __Type: {
    name: (_ctx, s) => s.typeName,
    kind: (_ctx, s) => (TYPE_ENUMS[String(s.typeName)] ? "ENUM" : "OBJECT"),
    fields: (_ctx, s) =>
      (TYPE_FIELDS[String(s.typeName)] ?? []).map((name) => src("__Field", { name })),
    enumValues: (_ctx, s) =>
      (TYPE_ENUMS[String(s.typeName)] ?? []).map((name) => src("__EnumValue", { name })),
  },
  __Field: { name: (_ctx, s) => s.name, description: () => null },
  __EnumValue: { name: (_ctx, s) => s.name, description: () => null },
};

// ---------------------------------------------------------------- execution

function executeSelection(
  ctx: Ctx,
  typeName: string,
  source: Source | null,
  selection: SelectionNode[],
): Record<string, unknown> | null {
  if (source === null) return null;
  const out: Record<string, unknown> = {};
  const fields = RESOLVERS[typeName] ?? {};
  const knownFields = TYPE_FIELDS[typeName] ?? Object.keys(fields);
  for (const node of selection) {
    if (node.kind === "fragment") {
      if (node.typeCondition === typeName || node.typeCondition === "Node") {
        const sub = executeSelection(ctx, typeName, source, node.selection);
        if (sub) Object.assign(out, sub);
      }
      continue;
    }
    const field = node.field;
    const key = field.alias ?? field.name;
    if (field.name === "__typename") {
      out[key] = typeName;
      continue;
    }
    const resolver = fields[field.name];
    if (!resolver || !knownFields.includes(field.name)) {
      ctx.errors.push({
        message: `Field '${field.name}' doesn't exist on type '${typeName}'`,
      });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.vars);
    let value: unknown;
    try {
      value = resolver(ctx, source, args);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field.selection);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, selection: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selection));
  if (typeof value === "object" && (value as Source).__type) {
    const source = value as Source;
    if (!selection) return source;
    return executeSelection(ctx, source.__type, source, selection);
  }
  return value;
}

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function executeGraphQL(store: Store, request: GraphQLRequest): Record<string, unknown> {
  const ctx: Ctx = { store, vars: request.variables ?? {}, errors: [] };
  let ops: Operation[];
  try {
    ops = new Parser(tokenize(request.query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  let op = ops[0];
  if (request.operationName) {
    op = ops.find((candidate) => candidate.name === request.operationName) ?? op;
  }
  if (!op) return { errors: [{ message: "no operation found" }] };
  const rootType = op.type === "mutation" ? "Mutation" : "Query";
  const data = executeSelection(ctx, rootType, src(rootType, {}), op.selection);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length) response.errors = ctx.errors;
  return response;
}

/** Handles a single request or a JSON batch (array) of requests. */
export function executeGraphQLBody(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => executeGraphQL(store, item as GraphQLRequest));
  }
  return executeGraphQL(store, body as GraphQLRequest);
}
