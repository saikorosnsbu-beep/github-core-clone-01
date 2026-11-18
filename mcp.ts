// MCP (Model Context Protocol) over streamable HTTP, JSON-RPC 2.0.
// The six required tools are the same domain operations as REST/GraphQL, so an
// object created over MCP is the same object over REST (ids stable).

import type { Store, RepoRec } from "./store.ts";
import { addressRepo } from "./store.ts";
import {
  HttpError,
  repoJson,
  issueJson,
  pullJson,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
} from "./domain.ts";

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;

const SERVER_INFO = { name: "forge", version: "1.0.0" };
const FALLBACK_REVISION = "2025-03-26";

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
  run: (store: Store, args: Record<string, unknown>) => unknown;
}

function str(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function num(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function resolveRepo(store: Store, args: Record<string, unknown>): RepoRec {
  let owner = str(args, "owner", "user", "username", "user_login", "organization", "org");
  let repoName = str(args, "repo", "repository", "repo_name", "repository_name", "name");
  const full = str(args, "full_name", "repo_full_name", "repository_full_name");
  if (full && full.includes("/")) {
    const [o, r] = full.split("/", 2);
    owner = owner ?? o;
    repoName = repoName ?? r;
  }
  if (!repoName) throw new Error("missing required argument: repo");
  const repo = addressRepo(store, owner ?? store.viewerLogin(), repoName);
  if (!repo) throw new Error(`repository ${owner ?? ""}/${repoName} not found`);
  return repo;
}

export const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository for the authenticated user.",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Repository name" },
      owner: { type: "string", description: "Repository owner login" },
      description: { type: "string", description: "Repository description" },
      private: { type: "boolean", description: "Whether the repository is private" },
    },
    run: (store, args) => {
      const name = str(args, "name", "repo", "repository", "repo_name", "repository_name");
      if (!name) throw new Error("missing required argument: name");
      if (store.findRepo(name)) throw new Error(`repository ${name} already exists`);
      const isPrivate = typeof args.private === "boolean" ? args.private : false;
      const description = str(args, "description") ?? "";
      const repo = store.createRepo(name, isPrivate, description, "main");
      const owner = str(args, "owner", "user", "username");
      if (owner) repo.owner = owner;
      return repoJson(store, repo);
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    required: ["owner", "repo"],
    properties: {
      owner: { type: "string", description: "Repository owner login" },
      repo: { type: "string", description: "Repository name" },
    },
    run: (store, args) => repoJson(store, resolveRepo(store, args)),
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    required: ["owner", "repo", "title"],
    properties: {
      owner: { type: "string", description: "Repository owner login" },
      repo: { type: "string", description: "Repository name" },
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body" },
    },
    run: (store, args) => {
      const repo = resolveRepo(store, args);
      const title = str(args, "title", "issue_title", "subject");
      if (!title) throw new Error("missing required argument: title");
      const issue = createIssueRecord(store, repo, { title, body: str(args, "body", "description") ?? "" });
      return issueJson(store, repo, issue);
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    required: ["owner", "repo"],
    properties: {
      owner: { type: "string", description: "Repository owner login" },
      repo: { type: "string", description: "Repository name" },
      state: { type: "string", description: "Filter by state: open, closed or all" },
    },
    run: (store, args) => {
      const repo = resolveRepo(store, args);
      const state = str(args, "state") ?? "open";
      const items = [...repo.issues.values()]
        .filter((issue) => state === "all" || issue.state === state)
        .sort((a, b) => a.number - b.number);
      return items.map((issue) => issueJson(store, repo, issue));
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request in a repository.",
    required: ["owner", "repo", "title", "head", "base"],
    properties: {
      owner: { type: "string", description: "Repository owner login" },
      repo: { type: "string", description: "Repository name" },
      title: { type: "string", description: "Pull request title" },
      body: { type: "string", description: "Pull request body" },
      head: { type: "string", description: "Head branch name" },
      base: { type: "string", description: "Base branch name" },
    },
    run: (store, args) => {
      const repo = resolveRepo(store, args);
      const title = str(args, "title", "pr_title", "pull_request_title", "subject");
      const head = str(args, "head", "head_branch", "source", "source_branch", "source_ref", "head_ref");
      const base = str(args, "base", "base_branch", "target", "target_branch", "target_ref", "base_ref");
      if (!title) throw new Error("missing required argument: title");
      if (!head) throw new Error("missing required argument: head");
      if (!base) throw new Error("missing required argument: base");
      try {
        const pull = createPullRecord(store, repo, { title, body: str(args, "body", "description") ?? "", head, base });
        return pullJson(store, repo, pull);
      } catch (error) {
        if (error instanceof HttpError) throw new Error(error.message);
        throw error;
      }
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request in a repository.",
    required: ["owner", "repo", "pull_number"],
    properties: {
      owner: { type: "string", description: "Repository owner login" },
      repo: { type: "string", description: "Repository name" },
      pull_number: { type: "number", description: "Pull request number" },
      merge_method: { type: "string", description: "Merge method: merge, squash or rebase" },
    },
    run: (store, args) => {
      const repo = resolveRepo(store, args);
      const number = num(args, "pull_number", "pullNumber", "number", "pull_request_number", "pr_number", "issue_number");
      if (number === undefined) throw new Error("missing required argument: pull_number");
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`pull request ${number} not found`);
      const method = (str(args, "merge_method", "mergeMethod", "method") ?? "merge").toLowerCase();
      try {
        const { sha } = mergePullRecord(store, repo, pull, method);
        return { merged: true, sha, message: "Pull Request successfully merged" };
      } catch (error) {
        if (error instanceof HttpError) throw new Error(error.message);
        throw error;
      }
    },
  },
];

/** The tools/list payload is built once so repeated calls are byte-for-byte identical. */
export const TOOLS_LIST_JSON: string = JSON.stringify({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: tool.properties,
      required: tool.required,
    },
  })),
});

export interface McpOutcome {
  status: number;
  body: string | null; // null => no body (e.g. 202 for notifications)
  sessionId?: string;
}

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpOutcome {
  return { status, body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }) };
}

/**
 * Handle one MCP HTTP request body. Returns the HTTP outcome.
 * Parse errors are answered at HTTP 400 with a JSON-RPC -32700 error object.
 */
export function handleMcp(store: Store, rawBody: string): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rpcError(null, JSON_RPC_PARSE_ERROR, "Parse error: body is not valid JSON", 400);
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const item of parsed) {
      const outcome = handleOne(store, item);
      if (outcome.body) results.push(JSON.parse(outcome.body));
    }
    return { status: 200, body: JSON.stringify(results) };
  }
  return handleOne(store, parsed);
}

function handleOne(store: Store, message: unknown): McpOutcome {
  if (typeof message !== "object" || message === null) {
    return rpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request");
  }
  const record = message as Record<string, unknown>;
  const id = record.id;
  const method = typeof record.method === "string" ? record.method : "";
  const params = (record.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : FALLBACK_REVISION;
      return {
        status: 200,
        sessionId: "forge-session",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: requested,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        }),
      };
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return { status: 200, body: `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${TOOLS_LIST_JSON}}` };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      // Required-argument validation: answer isError (the suite also accepts -32602).
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === null || args[required] === "") {
          // create_repo's canonical required arg is "name"; aliases count.
          if (tool.name === "create_repo" && required === "name" && str(args, "repo", "repository")) continue;
          if (tool.name === "merge_pull_request" && required === "pull_number" &&
              num(args, "number", "pull_request_number", "pr_number") !== undefined) continue;
          return rpcResult(id, {
            content: [{ type: "text", text: `Error: missing required argument "${required}"` }],
            isError: true,
          });
        }
      }
      try {
        const value = tool.run(store, args);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (error) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification || method.startsWith("notifications/")) {
        return { status: 202, body: null };
      }
      return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}
