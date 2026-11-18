// Shared in-memory store for the forge. Everything lives in Maps; nothing touches disk.
// Deterministic: timestamps come from a logical clock so repeated runs behave identically.

export interface GitObjectRec {
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag
  payload: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  tick: number;
}

export interface CommentRec {
  id: number;
  body: string;
  tick: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  head: string;
  base: string;
  mergeCommitSha: string | null;
  mergedTick: number | null;
  tick: number;
}

export interface RepoRec {
  name: string; // as created (case preserved for display)
  key: string; // lowercase lookup key
  owner: string | null; // adopted on first addressed access
  isPrivate: boolean;
  description: string;
  dbId: number;
  defaultBranch: string;
  objects: Map<string, GitObjectRec>;
  refs: Map<string, string>; // full ref name ("refs/heads/main") -> sha
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  comments: Map<number, CommentRec[]>;
  nextNumber: number; // issues and pull requests share one sequence, like GitHub
  tick: number;
}

const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export class Store {
  repos = new Map<string, RepoRec>();
  tickCount = 0;
  repoSeq = 5000;
  issueSeq = 90000;
  commentSeq = 700000;
  requestSeq = 0;

  tick(): number {
    this.tickCount += 1;
    return this.tickCount;
  }

  /** ISO timestamp for the given tick (logical clock, 1s per operation). */
  iso(tick: number): string {
    return new Date(EPOCH_MS + tick * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  nowIso(): string {
    return this.iso(this.tickCount);
  }

  /** Unix seconds for git commits at the given tick. */
  unix(tick: number): number {
    return Math.floor(EPOCH_MS / 1000) + tick;
  }

  requestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(36)}-${Date.now().toString(36)}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string, defaultBranch: string): RepoRec {
    const repo: RepoRec = {
      name,
      key: name.toLowerCase(),
      owner: null,
      isPrivate,
      description,
      dbId: ++this.repoSeq,
      defaultBranch: defaultBranch || "main",
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      tick: this.tick(),
    };
    this.repos.set(repo.key, repo);
    return repo;
  }

  findRepo(name: string): RepoRec | null {
    return this.repos.get(name.toLowerCase()) ?? null;
  }

  /** The login every surface treats as "the viewer": the first adopted owner. */
  viewerLogin(): string {
    for (const repo of this.repos.values()) {
      if (repo.owner) return repo.owner;
    }
    return "forge-user";
  }
}

/**
 * Address a repo by owner/name. Adopts the owner on first addressed access;
 * afterwards a mismatched owner means "not found" (GitHub returns 404, not 403,
 * for a repository that is not the addressed owner's).
 */
export function addressRepo(store: Store, owner: string, name: string): RepoRec | null {
  const repo = store.findRepo(name);
  if (!repo) return null;
  if (repo.owner === null) {
    repo.owner = owner;
    return repo;
  }
  return repo.owner === owner ? repo : null;
}

/** Relay-style node id: base64 of "<Type>:<dbId>". Decodable, stable per object. */
export function nodeId(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, "utf8").toString("base64");
}

export function parseNodeId(id: string): { type: string; dbId: number } | null {
  try {
    const raw = Buffer.from(id, "base64").toString("utf8");
    const idx = raw.lastIndexOf(":");
    if (idx < 0) return null;
    const dbId = Number(raw.slice(idx + 1));
    if (!Number.isFinite(dbId)) return null;
    return { type: raw.slice(0, idx), dbId };
  } catch {
    return null;
  }
}
