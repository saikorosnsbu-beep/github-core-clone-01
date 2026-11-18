// Domain operations shared by the REST, GraphQL and MCP surfaces, so an object
// created over one surface is the same object (same ids) over the others.

import type { Store, RepoRec, IssueRec, PullRec, CommentRec } from "./store.ts";
import { nodeId } from "./store.ts";
import {
  storeObject,
  parseCommit,
  flattenTree,
  unflattenTree,
  commitAncestors,
  commitGenerations,
} from "./git.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(branchRef(branch)) ?? null;
}

export function identity(store: Store, repo: RepoRec): string {
  const login = repo.owner ?? store.viewerLogin();
  return `${login} <${login}@users.noreply.github.com>`;
}

export function makeCommit(
  store: Store,
  repo: RepoRec,
  opts: { tree: string; parents: string[]; message: string },
): string {
  const tick = store.tick();
  const ts = store.unix(tick);
  const who = identity(store, repo);
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who} ${ts} +0000`);
  lines.push(`committer ${who} ${ts} +0000`);
  lines.push("");
  lines.push(opts.message);
  return storeObject(repo, "commit", Buffer.from(lines.join("\n"), "utf8"));
}

/** Flat path -> {mode, sha} map at a commit (empty map for null). */
export function treeMapAt(repo: RepoRec, commitSha: string | null): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  if (!commitSha) return out;
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 1) return out;
  const commit = parseCommit(obj.payload);
  if (commit.tree) flattenTree(repo, commit.tree, "", out);
  return out;
}

export function sortedBranches(repo: RepoRec): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith("refs/heads/")) out.push({ name: ref.slice("refs/heads/".length), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------- JSON shapes

export function repoJson(store: Store, repo: RepoRec): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin();
  return {
    id: repo.dbId,
    node_id: nodeId("Repository", repo.dbId),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description ?? "",
    owner: { login: owner, id: 1, type: "User" },
    default_branch: repo.defaultBranch,
    html_url: `https://forge.local/${owner}/${repo.name}`,
    clone_url: `https://forge.local/${owner}/${repo.name}.git`,
    created_at: store.iso(repo.tick),
    updated_at: store.nowIso(),
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === "open").length,
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name.toLowerCase());
  if (!label) return null;
  return { name: label.name, color: label.color, description: label.description ?? "" };
}

export function issueJson(store: Store, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin();
  return {
    id: issue.id,
    node_id: nodeId("Issue", issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter(Boolean),
    user: { login: owner },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: store.iso(issue.tick),
    updated_at: store.iso(issue.tick),
    html_url: `https://forge.local/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(store: Store, repo: RepoRec, comment: CommentRec): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin();
  return {
    id: comment.id,
    node_id: nodeId("IssueComment", comment.id),
    body: comment.body,
    user: { login: owner },
    created_at: store.iso(comment.tick),
    updated_at: store.iso(comment.tick),
  };
}

/** Mergeability: dry-run the 3-way merge; conflict iff some path changed both sides differently. */
export function computeMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== "open") return false;
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (!headTip || !baseTip) return false;
  return planMerge(repo, pull).conflict === false;
}

interface MergePlan {
  conflict: boolean;
  mergedTree?: Map<string, { mode: string; sha: string }>;
  baseTip: string;
  headTip: string;
}

export function planMerge(repo: RepoRec, pull: PullRec): MergePlan {
  const headTip = branchTip(repo, pull.head) ?? "";
  const baseTip = branchTip(repo, pull.base) ?? "";
  const baseCommit = mergeBase(repo, baseTip, headTip);
  const baseMap = treeMapAt(repo, baseCommit);
  const headMap = treeMapAt(repo, headTip);
  const targetMap = treeMapAt(repo, baseTip);
  const merged = new Map(targetMap);
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    const t = targetMap.get(path);
    const sameSha = (x?: { sha: string }, y?: { sha: string }) =>
      (x?.sha ?? null) === (y?.sha ?? null);
    if (sameSha(h, b)) continue; // head did not change it; keep target
    if (sameSha(t, b)) {
      // only head changed it
      if (h) merged.set(path, h);
      else merged.delete(path);
      continue;
    }
    if (sameSha(t, h)) continue; // both made the same change
    return { conflict: true, baseTip, headTip };
  }
  return { conflict: false, mergedTree: merged, baseTip, headTip };
}

export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  if (!a || !b) return null;
  const ancestorsA = commitAncestors(repo, a);
  const genB = commitGenerations(repo, [b]);
  let best: string | null = null;
  let bestGen = Number.POSITIVE_INFINITY;
  for (const [sha, gen] of genB) {
    if (ancestorsA.has(sha) && gen < bestGen) {
      best = sha;
      bestGen = gen;
    }
  }
  return best;
}

export function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin();
  return {
    id: pull.id,
    node_id: nodeId("PullRequest", pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.merged ? "closed" : pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? store.iso(pull.mergedTick ?? pull.tick) : null,
    closed_at: pull.merged || pull.state === "closed" ? store.iso(pull.mergedTick ?? pull.tick) : null,
    mergeable: computeMergeable(repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: branchTip(repo, pull.head) },
    base: { ref: pull.base, sha: branchTip(repo, pull.base) },
    user: { login: owner },
    created_at: store.iso(pull.tick),
    updated_at: store.iso(pull.tick),
    html_url: `https://forge.local/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- operations

export function createIssueRecord(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; labels?: string[] },
): IssueRec {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name.toLowerCase())) {
      throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
    }
  }
  const issue: IssueRec = {
    number: repo.nextNumber++,
    id: ++store.issueSeq,
    title: input.title,
    body: input.body ?? "",
    state: "open",
    labels: [...labels],
    tick: store.tick(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRecord(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): PullRec {
  if (!branchTip(repo, input.head)) {
    throw new HttpError(422, `Validation Failed: head branch "${input.head}" does not exist`);
  }
  if (!branchTip(repo, input.base)) {
    throw new HttpError(422, `Validation Failed: base branch "${input.base}" does not exist`);
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === "open" && existing.head === input.head && existing.base === input.base) {
      throw new HttpError(422, "Validation Failed: a pull request already exists for this head and base");
    }
  }
  const pull: PullRec = {
    number: repo.nextNumber++,
    id: ++store.issueSeq,
    title: input.title,
    body: input.body ?? "",
    state: "open",
    merged: false,
    head: input.head,
    base: input.base,
    mergeCommitSha: null,
    mergedTick: null,
    tick: store.tick(),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

function blobLines(repo: RepoRec, sha: string | undefined): string[] {
  if (!sha) return [];
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 3) return [];
  const text = obj.payload.toString("utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-diff counts via a longest-common-subsequence over lines (files here are small). */
function lineDiffCounts(baseLines: string[], headLines: string[]): { additions: number; deletions: number } {
  const n = baseLines.length;
  const m = headLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = baseLines[i] === headLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: m - lcs, deletions: n - lcs };
}

export interface PullFileEntry {
  filename: string;
  status: string;
  sha: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

/** Files changed by a pull request: head tree vs merge-base tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): PullFileEntry[] {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  const baseCommit = headTip && baseTip ? mergeBase(repo, baseTip, headTip) : null;
  const baseMap = treeMapAt(repo, baseCommit);
  const headMap = treeMapAt(repo, headTip);
  const files: PullFileEntry[] = [];
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b && !h) {
      const deletions = blobLines(repo, b.sha).length;
      files.push({ filename: path, status: "removed", sha: null, additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const additions = blobLines(repo, h.sha).length;
      files.push({ filename: path, status: "added", sha: h.sha, additions, deletions: 0, changes: additions });
    } else if (b && h && b.sha !== h.sha) {
      const { additions, deletions } = lineDiffCounts(blobLines(repo, b.sha), blobLines(repo, h.sha));
      files.push({ filename: path, status: "modified", sha: h.sha, additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** Merge a pull request. Returns the resulting commit sha on the base branch. */
export function mergePullRecord(
  store: Store,
  repo: RepoRec,
  pull: PullRec,
  method: string,
): { sha: string } {
  if (pull.merged) throw new HttpError(405, "Pull Request is not mergeable: already merged");
  if (pull.state !== "open") throw new HttpError(405, "Pull Request is not mergeable: closed");
  const plan = planMerge(repo, pull);
  if (!plan.mergedTree) throw new HttpError(405, "Pull Request is not mergeable: merge conflict");
  const tree = unflattenTree(repo, plan.mergedTree);
  let sha: string;
  if (method === "squash") {
    const message = `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ""}`;
    sha = makeCommit(store, repo, { tree, parents: [plan.baseTip], message });
  } else if (method === "rebase") {
    // Linear replay is approximated by a single commit with the merged tree.
    sha = makeCommit(store, repo, {
      tree,
      parents: [plan.baseTip],
      message: pull.title,
    });
  } else {
    sha = makeCommit(store, repo, {
      tree,
      parents: [plan.baseTip, plan.headTip],
      message: `Merge pull request #${pull.number} from ${pull.head}`,
    });
  }
  repo.refs.set(branchRef(pull.base), sha);
  pull.merged = true;
  pull.state = "closed";
  pull.mergeCommitSha = sha;
  pull.mergedTick = store.tick();
  return { sha };
}
