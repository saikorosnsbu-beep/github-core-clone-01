// The forge entry: a GitHub-compatible git forge in one process, stdlib only.
// Surfaces: REST (/api/v3), git smart HTTP (v0 + v2), GraphQL (/api/graphql), MCP (/mcp).

import http from "node:http";

interface AppRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}
import { Store, addressRepo } from "./store.ts";
import type { RepoRec } from "./store.ts";
import {
  HttpError,
  branchRef,
  branchTip,
  makeCommit,
  treeMapAt,
  repoJson,
  labelJson,
  issueJson,
  commentJson,
  pullJson,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
  pullFiles,
  sortedBranches,
} from "./domain.ts";
import {
  ZERO_SHA,
  storeObject,
  parseCommit,
  commitGenerations,
  reachableObjects,
  isAncestor,
  peelToCommit,
  buildPack,
  parsePack,
  unflattenTree,
  applyDelta,
  pktLine,
  PKT_FLUSH,
  PKT_DELIM,
  PktReader,
  sidebandWrap,
} from "./git.ts";
import type { ParsedPackObject } from "./git.ts";
import { executeGraphQLBody } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";

const JSON_TYPE = "application/json; charset=utf-8";

export function createApp(): http.Server {
  const store = new Store();
  const packCache = new Map<string, Buffer>();

  function headers(req: AppRequest, extra: Record<string, string>): Record<string, string> {
    return {
      "x-github-request-id": store.requestId(),
      "x-github-media-type": "github.v3",
      ...extra,
    };
  }

  function json(req: AppRequest, status: number, value: unknown, extra: Record<string, string> = {}): AppResponse {
    return {
      status,
      headers: headers(req, { "content-type": JSON_TYPE, ...extra }),
      body: `${JSON.stringify(value)}\n`,
    };
  }

  function errorJson(req: AppRequest, status: number, message: string): AppResponse {
    return json(req, status, { message, documentation_url: "https://docs.github.com/rest" });
  }

  function authorized(req: AppRequest): boolean {
    const expected = process.env.MAKEFUN_SHOP_TOKEN;
    if (!expected) return false;
    const header = req.headers["authorization"];
    return typeof header === "string" && header === `Bearer ${expected}`;
  }

  // -------------------------------------------------------------- REST core

  function parsePage(req: AppRequest): { perPage: number; page: number } {
    const perPageRaw = Number(req.query.per_page);
    const pageRaw = Number(req.query.page);
    return {
      perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
      page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    };
  }

  function paginate<T>(req: AppRequest, path: string, items: T[]): { page: T[]; link?: string } {
    const { perPage, page } = parsePage(req);
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    let link: string | undefined;
    if (page < totalPages) {
      const origin = `http://${req.headers["host"] ?? "localhost"}`;
      const next = `${origin}${path}?per_page=${perPage}&page=${page + 1}`;
      const last = `${origin}${path}?per_page=${perPage}&page=${totalPages}`;
      link = `<${next}>; rel="next", <${last}>; rel="last"`;
    }
    return { page: slice, link };
  }

  function requireRepo(req: AppRequest, owner: string, name: string): RepoRec {
    const repo = addressRepo(store, owner, name);
    if (!repo) throw new HttpError(404, "Not Found");
    return repo;
  }

  function bodyJson(req: AppRequest): Record<string, unknown> {
    if (!req.body || req.body.length === 0) return {};
    try {
      const parsed = JSON.parse(req.body.toString("utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, "Invalid JSON in request body");
    }
  }

  function rest(req: AppRequest, segments: string[]): AppResponse {
    const method = req.method;
    // Root + meta + user
    if (segments.length === 0) {
      if (method === "GET") {
        return json(req, 200, {
          current_user_url: "/api/v3/user",
          repository_url: "/api/v3/repos/{owner}/{repo}",
        });
      }
      throw new HttpError(404, "Not Found");
    }
    if (segments[0] === "meta" && segments.length === 1) {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      return json(req, 200, {
        installed_version: "1.0.0",
        verifiable_password_authentication: false,
      });
    }
    if (segments[0] === "user" && segments.length === 1) {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      return json(req, 200, { login: store.viewerLogin(), id: 1, type: "User" });
    }
    if (segments[0] === "user" && segments[1] === "repos" && segments.length === 2) {
      if (method === "POST") {
        const body = bodyJson(req);
        const name = String(body.name ?? "");
        if (!name) throw new HttpError(422, "Repository creation failed: name is required");
        if (store.findRepo(name)) {
          return json(req, 422, {
            message: "Repository creation failed.",
            errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }],
          });
        }
        const repo = store.createRepo(
          name,
          body.private === true,
          typeof body.description === "string" ? body.description : "",
          typeof body.default_branch === "string" ? body.default_branch : "main",
        );
        if (body.auto_init === true) {
          const emptyTree = storeObject(repo, "tree", Buffer.alloc(0));
          const commit = makeCommit(store, repo, { tree: emptyTree, parents: [], message: "Initial commit" });
          repo.refs.set(branchRef(repo.defaultBranch), commit);
        }
        return json(req, 201, repoJson(store, repo));
      }
      if (method === "GET") {
        const mine = [...store.repos.values()]
          .filter((repo) => repo.owner === null || repo.owner === store.viewerLogin())
          .sort((a, b) => a.tick - b.tick);
        const { page, link } = paginate(req, "/api/v3/user/repos", mine);
        return json(req, 200, page.map((repo) => repoJson(store, repo)), link ? { link } : {});
      }
      throw new HttpError(404, "Not Found");
    }

    if (segments[0] !== "repos" || segments.length < 3) throw new HttpError(404, "Not Found");
    const owner = segments[1];
    const repoName = segments[2];
    const restSegs = segments.slice(3);
    const repo = requireRepo(req, owner, repoName);

    // /repos/{o}/{r}
    if (restSegs.length === 0) {
      if (method === "GET") return json(req, 200, repoJson(store, repo));
      if (method === "PATCH") {
        const body = bodyJson(req);
        if (typeof body.name === "string" && body.name && body.name.toLowerCase() !== repo.key) {
          store.repos.delete(repo.key);
          repo.name = body.name;
          repo.key = body.name.toLowerCase();
          store.repos.set(repo.key, repo);
          packCache.clear();
        }
        if (typeof body.private === "boolean") repo.isPrivate = body.private;
        if (typeof body.description === "string") repo.description = body.description;
        if (typeof body.default_branch === "string" && body.default_branch) repo.defaultBranch = body.default_branch;
        return json(req, 200, repoJson(store, repo));
      }
      if (method === "DELETE") {
        store.repos.delete(repo.key);
        packCache.clear();
        return { status: 204, headers: headers(req, {}), body: "" };
      }
      throw new HttpError(404, "Not Found");
    }

    // /git/refs
    if (restSegs[0] === "git" && restSegs[1] === "refs" && restSegs.length === 2) {
      if (method !== "POST") throw new HttpError(404, "Not Found");
      const body = bodyJson(req);
      const ref = String(body.ref ?? "");
      const sha = String(body.sha ?? "");
      if (!ref.startsWith("refs/")) throw new HttpError(422, "Validation Failed: ref is invalid");
      if (!repo.objects.has(sha)) throw new HttpError(422, "Validation Failed: object does not exist");
      repo.refs.set(ref, sha);
      return json(req, 201, { ref, node_id: "", url: "", object: { sha, type: "commit" } });
    }

    // /branches
    if (restSegs[0] === "branches" && restSegs.length === 1) {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      return json(req, 200, sortedBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
    }

    // /commits
    if (restSegs[0] === "commits" && restSegs.length === 1) {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      const shaParam = typeof req.query.sha === "string" ? req.query.sha : repo.defaultBranch;
      let tip: string | null = repo.objects.has(shaParam) ? shaParam : branchTip(repo, shaParam);
      if (!tip) return json(req, 200, []);
      const gens = commitGenerations(repo, [tip]);
      const commits = [...gens.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([sha]) => sha);
      const { page, link } = paginate(req, `/api/v3/repos/${owner}/${repoName}/commits`, commits);
      return json(
        req,
        200,
        page.map((sha) => {
          const commit = parseCommit(repo.objects.get(sha)?.payload ?? Buffer.alloc(0));
          return {
            sha,
            commit: {
              message: commit.message,
              tree: { sha: commit.tree },
              author: { name: store.viewerLogin(), email: "", date: store.nowIso() },
              committer: { name: store.viewerLogin(), email: "", date: store.nowIso() },
            },
            parents: commit.parents.map((parent) => ({ sha: parent })),
          };
        }),
        link ? { link } : {},
      );
    }

    // /contents/{path...}
    if (restSegs[0] === "contents") {
      const path = restSegs.slice(1).join("/");
      return contentsRoute(req, repo, owner, repoName, path);
    }

    // /labels
    if (restSegs[0] === "labels" && restSegs.length === 1) {
      if (method === "GET") {
        return json(req, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description ?? "" })));
      }
      if (method === "POST") {
        const body = bodyJson(req);
        const name = String(body.name ?? "");
        const color = String(body.color ?? "ededed").replace(/^#/, "");
        if (!name) throw new HttpError(422, "Validation Failed: name is required");
        if (repo.labels.has(name.toLowerCase())) throw new HttpError(422, "Validation Failed: label already exists");
        repo.labels.set(name.toLowerCase(), {
          name,
          color,
          description: typeof body.description === "string" ? body.description : "",
        });
        return json(req, 201, { name, color, description: typeof body.description === "string" ? body.description : "" });
      }
      throw new HttpError(404, "Not Found");
    }

    // /issues
    if (restSegs[0] === "issues") {
      return issuesRoute(req, repo, restSegs.slice(1));
    }

    // /pulls
    if (restSegs[0] === "pulls") {
      return pullsRoute(req, repo, restSegs.slice(1));
    }

    throw new HttpError(404, "Not Found");
  }

  function contentsRoute(req: AppRequest, repo: RepoRec, owner: string, repoName: string, path: string): AppResponse {
    const method = req.method;
    if (method === "GET") {
      const ref = typeof req.query.ref === "string" ? req.query.ref : repo.defaultBranch;
      const tip = branchTip(repo, ref) ?? (repo.objects.has(ref) ? ref : null);
      const files = treeMapAt(repo, tip);
      if (path === "" || path === "/") {
        // root listing: top-level entries only
        const entries = new Map<string, { type: string; sha: string }>();
        for (const [filePath, file] of files) {
          const first = filePath.split("/")[0];
          if (filePath.includes("/")) {
            if (!entries.has(first)) entries.set(first, { type: "dir", sha: "" });
          } else {
            entries.set(first, { type: "file", sha: file.sha });
          }
        }
        return json(req, 200, [...entries.entries()].map(([name, entry]) => ({ name, path: name, type: entry.type, sha: entry.sha })));
      }
      const file = files.get(path);
      if (file) {
        const blob = repo.objects.get(file.sha);
        const content = blob ? blob.payload : Buffer.alloc(0);
        return json(req, 200, {
          type: "file",
          name: path.split("/").pop(),
          path,
          sha: file.sha,
          size: content.length,
          encoding: "base64",
          content: content.toString("base64"),
        });
      }
      // directory?
      const prefix = `${path}/`;
      const children = new Map<string, { type: string; sha: string }>();
      for (const [filePath, f] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const restPath = filePath.slice(prefix.length);
        const first = restPath.split("/")[0];
        if (restPath.includes("/")) {
          if (!children.has(first)) children.set(first, { type: "dir", sha: "" });
        } else {
          children.set(first, { type: "file", sha: f.sha });
        }
      }
      if (children.size) {
        return json(req, 200, [...children.entries()].map(([name, entry]) => ({ name, path: `${path}/${name}`, type: entry.type, sha: entry.sha })));
      }
      throw new HttpError(404, "Not Found");
    }
    if (method === "PUT") {
      const body = bodyJson(req);
      const branch = typeof body.branch === "string" ? body.branch : repo.defaultBranch;
      const tip = branchTip(repo, branch);
      const files = treeMapAt(repo, tip);
      const existing = files.get(path);
      const providedSha = typeof body.sha === "string" ? body.sha : null;
      if (existing && providedSha !== existing.sha) {
        if (providedSha === null) throw new HttpError(422, "Validation Failed: sha is required for updating an existing file");
        throw new HttpError(409, "Conflict: the file sha does not match the current version");
      }
      if (!existing && providedSha !== null && providedSha !== ZERO_SHA) {
        // creating with a sha that names nothing: treat as conflict-free create only if sha is null-ish
        throw new HttpError(422, "Validation Failed: sha supplied for a file that does not exist");
      }
      const raw = typeof body.content === "string" ? Buffer.from(body.content, "base64") : Buffer.alloc(0);
      const blobSha = storeObject(repo, "blob", raw);
      files.set(path, { mode: "100644", sha: blobSha });
      const tree = unflatten(repo, files);
      const message = typeof body.message === "string" ? body.message : `Update ${path}`;
      const commit = makeCommit(store, repo, { tree, parents: tip ? [tip] : [], message });
      repo.refs.set(branchRef(branch), commit);
      packCache.clear();
      return json(req, existing ? 200 : 201, {
        content: { name: path.split("/").pop(), path, sha: blobSha, encoding: "base64" },
        commit: { sha: commit },
      });
    }
    if (method === "DELETE") {
      const body = bodyJson(req);
      const branch = typeof body.branch === "string" ? body.branch : repo.defaultBranch;
      const tip = branchTip(repo, branch);
      const files = treeMapAt(repo, tip);
      const existing = files.get(path);
      if (!existing || !tip) throw new HttpError(404, "Not Found");
      if (typeof body.sha === "string" && body.sha !== existing.sha) {
        throw new HttpError(409, "Conflict: the file sha does not match the current version");
      }
      files.delete(path);
      const tree = unflatten(repo, files);
      const message = typeof body.message === "string" ? body.message : `Delete ${path}`;
      const commit = makeCommit(store, repo, { tree, parents: [tip], message });
      repo.refs.set(branchRef(branch), commit);
      packCache.clear();
      return json(req, 200, { content: null, commit: { sha: commit } });
    }
    throw new HttpError(404, "Not Found");
  }

  function unflatten(repo: RepoRec, files: Map<string, { mode: string; sha: string }>): string {
    // local indirection to keep imports tidy
    return unflattenTree(repo, files);
  }

  function issuesRoute(req: AppRequest, repo: RepoRec, segs: string[]): AppResponse {
    const method = req.method;
    if (segs.length === 0) {
      if (method === "POST") {
        const body = bodyJson(req);
        try {
          const issue = createIssueRecord(store, repo, {
            title: String(body.title ?? ""),
            body: typeof body.body === "string" ? body.body : "",
            labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
          });
          return json(req, 201, issueJson(store, repo, issue));
        } catch (error) {
          if (error instanceof HttpError) return errorJson(req, error.status, error.message);
          throw error;
        }
      }
      if (method === "GET") {
        const state = typeof req.query.state === "string" ? req.query.state : "open";
        const sort = typeof req.query.sort === "string" ? req.query.sort : "created";
        const direction = typeof req.query.direction === "string" ? req.query.direction : "desc";
        let items = [...repo.issues.values()];
        if (state === "open" || state === "closed") items = items.filter((issue) => issue.state === state);
        items.sort((a, b) => a.number - b.number);
        const descending = sort === "created" ? direction === "desc" : direction === "desc";
        if (descending) items.reverse();
        const { page, link } = paginate(req, `/api/v3/repos/x/y/issues`, items);
        return json(req, 200, page.map((issue) => issueJson(store, repo, issue)), link ? { link } : {});
      }
      throw new HttpError(404, "Not Found");
    }
    const number = Number(segs[0]);
    if (!Number.isFinite(number)) throw new HttpError(404, "Not Found");
    if (segs.length === 1) {
      const issue = repo.issues.get(number);
      if (method === "GET") {
        if (issue) return json(req, 200, issueJson(store, repo, issue));
        const pull = repo.pulls.get(number);
        if (pull) return json(req, 200, pullJson(store, repo, pull));
        throw new HttpError(404, "Not Found");
      }
      if (method === "PATCH") {
        if (!issue) throw new HttpError(404, "Not Found");
        const body = bodyJson(req);
        if (typeof body.title === "string") issue.title = body.title;
        if (typeof body.body === "string") issue.body = body.body;
        if (body.state === "open" || body.state === "closed") issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const names = body.labels.map((entry) =>
            typeof entry === "string" ? entry : String((entry as Record<string, unknown>)?.name ?? ""),
          );
          for (const name of names) {
            if (!repo.labels.has(name.toLowerCase())) {
              return errorJson(req, 422, `Validation Failed: label "${name}" does not exist`);
            }
          }
          issue.labels = names;
        }
        return json(req, 200, issueJson(store, repo, issue));
      }
      throw new HttpError(404, "Not Found");
    }
    if (segs.length === 2 && segs[1] === "comments") {
      const list = repo.comments.get(number) ?? [];
      if (method === "GET") {
        return json(req, 200, list.map((comment) => commentJson(store, repo, comment)));
      }
      if (method === "POST") {
        if (!repo.issues.has(number) && !repo.pulls.has(number)) throw new HttpError(404, "Not Found");
        const body = bodyJson(req);
        const comment = { id: ++store.commentSeq, body: String(body.body ?? ""), tick: store.tick() };
        list.push(comment);
        repo.comments.set(number, list);
        return json(req, 201, commentJson(store, repo, comment));
      }
      throw new HttpError(404, "Not Found");
    }
    throw new HttpError(404, "Not Found");
  }

  function pullsRoute(req: AppRequest, repo: RepoRec, segs: string[]): AppResponse {
    const method = req.method;
    if (segs.length === 0) {
      if (method === "POST") {
        const body = bodyJson(req);
        try {
          const pull = createPullRecord(store, repo, {
            title: String(body.title ?? ""),
            body: typeof body.body === "string" ? body.body : "",
            head: String(body.head ?? ""),
            base: String(body.base ?? repo.defaultBranch),
          });
          return json(req, 201, pullJson(store, repo, pull));
        } catch (error) {
          if (error instanceof HttpError) return errorJson(req, error.status, error.message);
          throw error;
        }
      }
      if (method === "GET") {
        const state = typeof req.query.state === "string" ? req.query.state : "open";
        let items = [...repo.pulls.values()];
        if (state === "open") items = items.filter((pull) => pull.state === "open" && !pull.merged);
        else if (state === "closed") items = items.filter((pull) => pull.state === "closed" || pull.merged);
        items.sort((a, b) => a.number - b.number);
        const { page, link } = paginate(req, `/api/v3/repos/x/y/pulls`, items);
        return json(req, 200, page.map((pull) => pullJson(store, repo, pull)), link ? { link } : {});
      }
      throw new HttpError(404, "Not Found");
    }
    const number = Number(segs[0]);
    if (!Number.isFinite(number)) throw new HttpError(404, "Not Found");
    const pull = repo.pulls.get(number);
    if (segs.length === 1) {
      if (method === "GET") {
        if (!pull) throw new HttpError(404, "Not Found");
        return json(req, 200, pullJson(store, repo, pull));
      }
      if (method === "PATCH") {
        if (!pull) throw new HttpError(404, "Not Found");
        const body = bodyJson(req);
        if (typeof body.title === "string") pull.title = body.title;
        if (typeof body.body === "string") pull.body = body.body;
        if (body.state === "closed" && !pull.merged) pull.state = "closed";
        if (body.state === "open" && !pull.merged) pull.state = "open";
        return json(req, 200, pullJson(store, repo, pull));
      }
      throw new HttpError(404, "Not Found");
    }
    if (!pull) throw new HttpError(404, "Not Found");
    if (segs.length === 2 && segs[1] === "files") {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      return json(req, 200, pullFiles(repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        sha: file.sha,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })));
    }
    if (segs.length === 2 && segs[1] === "merge") {
      if (method !== "PUT") throw new HttpError(404, "Not Found");
      const body = bodyJson(req);
      const mergeMethod = typeof body.merge_method === "string" ? body.merge_method : "merge";
      try {
        const { sha } = mergePullRecord(store, repo, pull, mergeMethod);
        return json(req, 200, { sha, merged: true, message: "Pull Request successfully merged" });
      } catch (error) {
        if (error instanceof HttpError) return errorJson(req, error.status, error.message);
        throw error;
      }
    }
    throw new HttpError(404, "Not Found");
  }

  // ------------------------------------------------------------ git smart HTTP

  const UPLOAD_CAPS_V2 = "version 2\nagent=forge/1.0\nls-refs=unborn\nfetch=shallow wait-for-done\nobject-format=sha1\n";
  const UPLOAD_CAPS_V0 =
    "multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=forge/1.0 object-format=sha1";
  const RECEIVE_CAPS_V0 =
    "report-status delete-refs side-band-64k quiet ofs-delta object-format=sha1 agent=forge/1.0";

  function sortedRefs(repo: RepoRec): Array<[string, string]> {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  function advertisement(req: AppRequest, repo: RepoRec, service: string): AppResponse {
    // Protocol v2 exists only for upload-pack; receive-pack is always advertised as v0.
    const isV2 = service === "git-upload-pack" && (req.headers["git-protocol"] ?? "").includes("version=2");
    const headRef = branchRef(repo.defaultBranch);
    const headSha = repo.refs.get(headRef);
    const lines: Buffer[] = [];
    lines.push(pktLine(`# service=${service}\n`));
    lines.push(PKT_FLUSH);
    if (isV2) {
      // One pkt-line per capability line: the parser keys on the first packet being
      // exactly "version 2".
      for (const line of UPLOAD_CAPS_V2.split("\n")) {
        if (line) lines.push(pktLine(`${line}\n`));
      }
      lines.push(PKT_FLUSH);
    } else if (service === "git-upload-pack") {
      const caps = `${UPLOAD_CAPS_V0} symref=HEAD:${headRef}`;
      if (headSha) {
        lines.push(pktLine(Buffer.concat([Buffer.from(`${headSha} HEAD\0${caps}\n`, "utf8")])));
      } else {
        lines.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_SHA} capabilities^{}\0${caps}\n`, "utf8")])));
      }
      for (const [ref, sha] of sortedRefs(repo)) {
        lines.push(pktLine(`${sha} ${ref}\n`));
        const peeled = peelToCommit(repo, sha);
        const obj = repo.objects.get(sha);
        if (obj && obj.type === 4 && peeled) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
      lines.push(PKT_FLUSH);
    } else {
      if (headSha) {
        lines.push(pktLine(Buffer.concat([Buffer.from(`${headSha} HEAD\0${RECEIVE_CAPS_V0}\n`, "utf8")])));
      } else {
        lines.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_SHA} capabilities^{}\0${RECEIVE_CAPS_V0}\n`, "utf8")])));
      }
      for (const [ref, sha] of sortedRefs(repo)) {
        lines.push(pktLine(`${sha} ${ref}\n`));
      }
      lines.push(PKT_FLUSH);
    }
    return {
      status: 200,
      headers: headers(req, {
        "content-type": `application/x-${service}-advertisement`,
        "cache-control": "no-cache",
      }),
      body: Buffer.concat(lines),
    };
  }

  function lsRefs(repo: RepoRec, args: string[]): Buffer {
    const peel = args.includes("peel");
    const symrefs = args.includes("symrefs");
    const unborn = args.includes("unborn");
    const prefixes = args.filter((arg) => arg.startsWith("ref-prefix ")).map((arg) => arg.slice("ref-prefix ".length));
    const matches = (name: string) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const out: Buffer[] = [];
    const headRef = branchRef(repo.defaultBranch);
    const headSha = repo.refs.get(headRef);
    if (matches("HEAD")) {
      if (headSha) {
        out.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${headRef}` : ""}\n`));
      } else if (unborn) {
        out.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ""}\n`));
      }
    }
    for (const [ref, sha] of sortedRefs(repo)) {
      if (!matches(ref)) continue;
      let line = `${sha} ${ref}`;
      if (peel) {
        const obj = repo.objects.get(sha);
        if (obj && obj.type === 4) {
          const peeled = peelToCommit(repo, sha);
          if (peeled) line += ` peeled:${peeled}`;
        }
      }
      out.push(pktLine(`${line}\n`));
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }

  interface FetchPlan {
    packShas: string[];
    shallowLines: string[];
  }

  function planFetch(
    repo: RepoRec,
    wants: string[],
    haves: string[],
    shallowClient: string[],
    deepen: number | null,
    deepenSince: number | null,
  ): FetchPlan {
    const shallowSet = new Set(shallowClient);
    const haveClosure = new Set<string>();
    for (const have of haves) {
      if (shallowSet.has(have)) {
        // A shallow have: the client holds that commit and its tree, but no ancestors.
        const obj = repo.objects.get(have);
        if (obj && obj.type === 1) {
          haveClosure.add(have);
          const commit = parseCommit(obj.payload);
          if (commit.tree) {
            for (const sha of reachableObjects(repo, [commit.tree])) haveClosure.add(sha);
          }
        } else if (obj) {
          haveClosure.add(have);
        }
      } else {
        for (const sha of reachableObjects(repo, [have])) haveClosure.add(sha);
      }
    }
    // commit inclusion by generation limit. A plain deepen (no client shallow
    // boundary) only needs generations up to the limit itself, so the history
    // walk stops there instead of walking every ancestor.
    const wantCommits = wants.filter((sha) => repo.objects.get(sha)?.type === 1);
    const gens =
      deepen !== null && shallowClient.length === 0
        ? commitGenerations(repo, wantCommits, deepen)
        : commitGenerations(repo, wantCommits);
    let limit = Number.POSITIVE_INFINITY;
    if (deepen !== null) {
      if (shallowClient.length) {
        // deepen relative to the client's current shallow boundary
        let baseGen = 0;
        for (const sha of shallowClient) {
          const gen = gens.get(sha);
          if (gen !== undefined) baseGen = Math.max(baseGen, gen);
        }
        limit = baseGen + deepen;
      } else {
        limit = deepen;
      }
    }
    const includedCommits = new Set<string>();
    for (const [sha, gen] of gens) {
      if (gen < limit) includedCommits.add(sha);
    }
    if (deepenSince !== null) {
      for (const sha of [...includedCommits]) {
        const obj = repo.objects.get(sha);
        if (obj && parseCommit(obj.payload).committerTime <= deepenSince) includedCommits.delete(sha);
      }
    }
    // boundary: included commits whose parents are not included
    const boundary: string[] = [];
    for (const sha of includedCommits) {
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      const parents = parseCommit(obj.payload).parents;
      if (parents.some((parent) => !includedCommits.has(parent) && gens.has(parent))) boundary.push(sha);
    }
    const shallowLines: string[] = [];
    const clientShallow = new Set(shallowClient);
    for (const sha of boundary) {
      if (!clientShallow.has(sha)) shallowLines.push(`shallow ${sha}`);
    }
    if (deepen !== null || deepenSince !== null) {
      for (const sha of shallowClient) {
        if (includedCommits.has(sha) && !boundary.includes(sha)) shallowLines.push(`unshallow ${sha}`);
      }
    }
    // objects: included commits + their trees/blobs + tag objects among wants
    const tipsForObjects: string[] = [];
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (!obj) continue;
      if (obj.type === 1) {
        if (includedCommits.has(want)) tipsForObjects.push(want);
      } else {
        tipsForObjects.push(want); // tags (and direct tree/blob wants)
      }
    }
    // reachable from included commits only (not from excluded ancestors)
    const objectSet = new Set<string>();
    const stack = [...tipsForObjects];
    while (stack.length) {
      const sha = stack.pop() as string;
      if (objectSet.has(sha)) continue;
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      if (obj.type === 1 && !includedCommits.has(sha)) continue;
      objectSet.add(sha);
      if (obj.type === 1) {
        const commit = parseCommit(obj.payload);
        if (commit.tree) stack.push(commit.tree);
        for (const parent of commit.parents) if (includedCommits.has(parent)) stack.push(parent);
      } else if (obj.type === 2) {
        const entries = parseTreePayload(obj.payload);
        for (const entry of entries) stack.push(entry.sha);
      } else if (obj.type === 4) {
        const peeled = peelToCommit(repo, sha);
        if (peeled && includedCommits.has(peeled)) stack.push(peeled);
      }
    }
    const packShas = [...objectSet].filter((sha) => !haveClosure.has(sha));
    return { packShas, shallowLines };
  }

  function parseTreePayload(payload: Buffer): Array<{ mode: string; name: string; sha: string }> {
    const entries: Array<{ mode: string; name: string; sha: string }> = [];
    let i = 0;
    while (i < payload.length) {
      const sp = payload.indexOf(0x20, i);
      const mode = payload.subarray(i, sp).toString("ascii");
      const nul = payload.indexOf(0x00, sp);
      const name = payload.subarray(sp + 1, nul).toString("utf8");
      const sha = payload.subarray(nul + 1, nul + 21).toString("hex");
      entries.push({ mode, name, sha });
      i = nul + 21;
    }
    return entries;
  }

  function cachedPack(repo: RepoRec, plan: FetchPlan, depthKey: string): Buffer {
    const key = `${repo.key}|${depthKey}|${[...plan.packShas].sort().join(",")}`;
    const hit = packCache.get(key);
    if (hit) return hit;
    const pack = buildPack(repo, plan.packShas);
    if (packCache.size > 64) packCache.clear();
    packCache.set(key, pack);
    return pack;
  }

  function uploadPack(req: AppRequest, repo: RepoRec): AppResponse {
    const isV2 = (req.headers["git-protocol"] ?? "").includes("version=2");
    const reader = new PktReader(req.body ?? Buffer.alloc(0));
    if (isV2) {
      // command line, then args until delim, then request lines until flush
      const first = reader.next();
      const command = first && first.kind === "data" ? first.payload.toString("utf8").trim() : "";
      if (command === "command=ls-refs") {
        // ls-refs arguments arrive after the delimiter, not before it.
        const args: string[] = [];
        for (;;) {
          const pkt = reader.next();
          if (!pkt) break;
          if (pkt.kind === "flush") break;
          if (pkt.kind === "data") args.push(pkt.payload.toString("utf8").replace(/\n$/, ""));
        }
        return {
          status: 200,
          headers: headers(req, { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" }),
          body: lsRefs(repo, args),
        };
      }
      if (command === "command=fetch") {
        const args: string[] = [];
        for (;;) {
          const pkt = reader.next();
          if (!pkt || pkt.kind !== "data") break;
          args.push(pkt.payload.toString("utf8").replace(/\n$/, ""));
        }
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let deepen: number | null = null;
        let deepenSince: number | null = null;
        let done = false;
        for (;;) {
          const pkt = reader.next();
          if (!pkt || pkt.kind === "flush") break;
          if (pkt.kind !== "data") continue;
          const line = pkt.payload.toString("utf8").replace(/\n$/, "");
          if (line.startsWith("want ")) wants.push(line.slice(5).trim());
          else if (line.startsWith("have ")) haves.push(line.slice(5).trim());
          else if (line.startsWith("shallow ")) shallow.push(line.slice(8).trim());
          else if (line.startsWith("deepen ")) deepen = Number(line.slice(7));
          else if (line.startsWith("deepen-since ")) deepenSince = Number(line.slice(13));
          else if (line === "done") done = true;
        }
        const plan = planFetch(repo, wants, haves, shallow, deepen, deepenSince);
        const pack = cachedPack(repo, plan, `d${deepen ?? ""}s${deepenSince ?? ""}`);
        const out: Buffer[] = [];
        if (!done) {
          const common = haves.filter((have) => repo.objects.has(have));
          out.push(pktLine("acknowledgments\n"));
          if (common.length === 0) out.push(pktLine("NAK\n"));
          else for (const sha of common) out.push(pktLine(`ACK ${sha}\n`));
          out.push(PKT_FLUSH);
        }
        if (plan.shallowLines.length) {
          out.push(pktLine("shallow-info\n"));
          for (const line of plan.shallowLines) out.push(pktLine(`${line}\n`));
          out.push(PKT_FLUSH);
        }
        out.push(pktLine("packfile\n"));
        for (const packet of sidebandWrap(pack)) out.push(packet);
        out.push(PKT_FLUSH);
        return {
          status: 200,
          headers: headers(req, { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" }),
          body: Buffer.concat(out),
        };
      }
      return errorJson(req, 400, "unsupported git command");
    }
    // ---- v0 fetch
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let deepen: number | null = null;
    let caps = "";
    for (;;) {
      const pkt = reader.next();
      if (!pkt || pkt.kind === "flush") break;
      if (pkt.kind !== "data") continue;
      let line = pkt.payload.toString("utf8").replace(/\n$/, "");
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      if (line.startsWith("want ")) wants.push(line.slice(5).trim());
      else if (line.startsWith("have ")) haves.push(line.slice(5).trim());
      else if (line.startsWith("shallow ")) shallow.push(line.slice(8).trim());
      else if (line.startsWith("deepen ")) deepen = Number(line.slice(7));
    }
    const plan = planFetch(repo, wants, haves, shallow, deepen, null);
    const pack = cachedPack(repo, plan, `v0d${deepen ?? ""}`);
    const out: Buffer[] = [];
    const common = haves.filter((have) => repo.objects.has(have));
    if (caps.includes("multi_ack_detailed")) {
      for (const sha of common) out.push(pktLine(`ACK ${sha} common\n`));
      out.push(pktLine("NAK\n"));
    } else if (common.length) {
      out.push(pktLine(`ACK ${common[common.length - 1]}\n`));
    } else {
      out.push(pktLine("NAK\n"));
    }
    for (const line of plan.shallowLines) out.push(pktLine(`${line}\n`));
    out.push(PKT_FLUSH);
    for (const packet of sidebandWrap(pack, "Counting objects: done.\n")) out.push(packet);
    out.push(PKT_FLUSH);
    return {
      status: 200,
      headers: headers(req, { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" }),
      body: Buffer.concat(out),
    };
  }

  function receivePack(req: AppRequest, repo: RepoRec): AppResponse {
    const reader = new PktReader(req.body ?? Buffer.alloc(0));
    interface Command {
      ref: string;
      oldSha: string;
      newSha: string;
    }
    const commands: Command[] = [];
    let caps = "";
    let first = true;
    for (;;) {
      const pkt = reader.next();
      if (!pkt || pkt.kind === "flush") break;
      if (pkt.kind !== "data") continue;
      let line = pkt.payload.toString("utf8").replace(/\n$/, "");
      if (first) {
        first = false;
        const nul = line.indexOf("\0");
        if (nul >= 0) {
          caps = line.slice(nul + 1);
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(" ");
      if (parts.length >= 3) {
        commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts.slice(2).join(" ") });
      }
    }
    const packBytes = reader.rest();
    let unpackOk = true;
    let unpackError = "";
    if (packBytes.length > 0) {
      try {
        const entries = parsePack(packBytes);
        storePackEntries(repo, entries);
      } catch (error) {
        unpackOk = false;
        unpackError = error instanceof Error ? error.message : String(error);
      }
    }
    const results: Array<{ ref: string; ok: boolean; message?: string }> = [];
    if (!unpackOk) {
      for (const command of commands) results.push({ ref: command.ref, ok: false, message: `unpack ${unpackError}` });
    } else {
      for (const command of commands) {
        const current = repo.refs.get(command.ref) ?? ZERO_SHA;
        if (command.newSha === ZERO_SHA) {
          // delete
          if (current === ZERO_SHA) {
            results.push({ ref: command.ref, ok: false, message: "reference does not exist" });
          } else {
            repo.refs.delete(command.ref);
            results.push({ ref: command.ref, ok: true });
          }
          continue;
        }
        const newObj = repo.objects.get(command.newSha);
        if (!newObj) {
          results.push({ ref: command.ref, ok: false, message: "unknown object" });
          continue;
        }
        if (command.oldSha === ZERO_SHA) {
          if (current !== ZERO_SHA) {
            results.push({ ref: command.ref, ok: false, message: "reference already exists" });
            continue;
          }
        } else {
          if (current !== command.oldSha) {
            results.push({ ref: command.ref, ok: false, message: "stale info" });
            continue;
          }
          // fast-forward check for branch refs pointing at commits
          if (newObj.type === 1 && command.oldSha !== ZERO_SHA) {
            if (!isAncestor(repo, command.oldSha, command.newSha)) {
              results.push({ ref: command.ref, ok: false, message: "non-fast-forward" });
              continue;
            }
          }
        }
        repo.refs.set(command.ref, command.newSha);
        results.push({ ref: command.ref, ok: true });
      }
    }
    packCache.clear();
    const reportLines: string[] = [`unpack ${unpackOk ? "ok" : `error ${unpackError}`}`];
    for (const result of results) {
      reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.message ?? "failed"}`);
    }
    const reportText = `${reportLines.join("\n")}\n`;
    const useSideband = caps.includes("side-band-64k");
    const out: Buffer[] = [];
    if (useSideband) {
      for (const packet of sidebandWrap(Buffer.from(reportText, "utf8"))) out.push(packet);
    } else {
      for (const line of reportLines) out.push(pktLine(`${line}\n`));
    }
    out.push(PKT_FLUSH);
    return {
      status: 200,
      headers: headers(req, { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" }),
      body: Buffer.concat(out),
    };
  }

  function storePackEntries(repo: RepoRec, entries: ParsedPackObject[]): void {
    // Resolve entries in order; deltas may reference earlier pack entries or repo objects.
    const resolvedByStart = new Map<number, { type: number; payload: Buffer; sha: string }>();
    const resolvedBySha = new Map<string, { type: number; payload: Buffer }>();
    const objectIdOf = (type: number, payload: Buffer): string => {
      const names: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
      return storeObject(repo, names[type], payload);
    };
    for (const entry of entries) {
      let type = entry.type;
      let payload = entry.payload;
      if (entry.type === 6) {
        const base = resolvedByStart.get(entry.entryStart - (entry.baseOffset ?? 0));
        if (!base) throw new Error("ofs-delta base missing");
        payload = applyDelta(base.payload, entry.payload);
        type = base.type;
      } else if (entry.type === 7) {
        const baseSha = entry.baseSha ?? "";
        const inPack = resolvedBySha.get(baseSha);
        const inRepo = repo.objects.get(baseSha);
        const base = inPack ?? (inRepo ? { type: inRepo.type, payload: inRepo.payload } : null);
        if (!base) throw new Error("ref-delta base missing");
        payload = applyDelta(base.payload, entry.payload);
        type = base.type;
      }
      const sha = objectIdOf(type, payload);
      resolvedByStart.set(entry.entryStart, { type, payload, sha });
      resolvedBySha.set(sha, { type, payload });
    }
  }

  // ------------------------------------------------------------ top-level

  async function handle(req: AppRequest): Promise<AppResponse> {
    const path = req.path;
    try {
      if (path === "/healthz") {
        return { status: 200, headers: { "content-type": "text/plain" }, body: "ok\n" };
      }
      if (!authorized(req)) {
        return errorJson(req, 401, "Bad credentials");
      }
      if (path === "/api/graphql" && req.method === "POST") {
        let parsed: unknown;
        try {
          parsed = JSON.parse((req.body ?? Buffer.alloc(0)).toString("utf8"));
        } catch {
          return json(req, 400, { errors: [{ message: "invalid JSON body" }] });
        }
        return json(req, 200, executeGraphQLBody(store, parsed));
      }
      if (path === "/mcp") {
        if (req.method === "GET" || req.method === "DELETE") {
          return { status: 405, headers: headers(req, { "content-type": JSON_TYPE }), body: "" };
        }
        if (req.method !== "POST") return errorJson(req, 404, "Not Found");
        const outcome = handleMcp(store, (req.body ?? Buffer.alloc(0)).toString("utf8"));
        const responseHeaders = headers(req, { "content-type": JSON_TYPE });
        if (outcome.sessionId) responseHeaders["mcp-session-id"] = outcome.sessionId;
        return { status: outcome.status, headers: responseHeaders, body: outcome.body ?? "" };
      }
      if (path === "/api/v3" || path.startsWith("/api/v3/")) {
        const restPath = path.slice("/api/v3".length).replace(/^\//, "");
        const segments = restPath === "" ? [] : restPath.split("/").map((segment) => decodeURIComponent(segment));
        const response = rest(req, segments);
        if (response.status >= 200 && response.status < 300) {
          response.headers["x-oauth-scopes"] = "repo, user";
        }
        return response;
      }
      const gitMatch = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const route = gitMatch[3];
        const repo = addressRepo(store, owner, repoName);
        if (!repo) return errorJson(req, 404, "Not Found");
        if (route === "info/refs" && req.method === "GET") {
          const service = typeof req.query.service === "string" ? req.query.service : "";
          if (service !== "git-upload-pack" && service !== "git-receive-pack") {
            return errorJson(req, 400, "unsupported service");
          }
          return advertisement(req, repo, service);
        }
        if (route === "git-upload-pack" && req.method === "POST") return uploadPack(req, repo);
        if (route === "git-receive-pack" && req.method === "POST") return receivePack(req, repo);
        return errorJson(req, 404, "Not Found");
      }
      return errorJson(req, 404, "Not Found");
    } catch (error) {
      if (error instanceof HttpError) return errorJson(req, error.status, error.message);
      return errorJson(req, 500, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const server = http.createServer((nodeReq, nodeRes) => {
    const chunks: Buffer[] = [];
    nodeReq.on("data", (chunk: Buffer) => chunks.push(chunk));
    nodeReq.on("end", () => {
      void (async () => {
        try {
          const url = new URL(nodeReq.url ?? "/", "http://forge.local");
          const query: Record<string, string | undefined> = {};
          for (const [key, value] of url.searchParams) {
            if (query[key] === undefined) query[key] = value;
          }
          const reqHeaders: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(nodeReq.headers)) {
            reqHeaders[key] = Array.isArray(value) ? value[0] : value;
          }
          const response = await handle({
            method: nodeReq.method ?? "GET",
            path: url.pathname,
            query,
            headers: reqHeaders,
            body: Buffer.concat(chunks),
          });
          nodeRes.writeHead(response.status, response.headers);
          nodeRes.end(response.body);
        } catch (error) {
          nodeRes.writeHead(500, { "content-type": "application/json" });
          nodeRes.end(JSON.stringify({ message: `Internal error: ${error instanceof Error ? error.message : String(error)}` }));
        }
      })();
    });
    nodeReq.on("error", () => {
      try {
        nodeRes.writeHead(400);
        nodeRes.end();
      } catch {
        // socket already gone
      }
    });
  });
  return server;
}
