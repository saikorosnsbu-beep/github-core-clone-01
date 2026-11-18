// Git object model + packfile + pkt-line machinery, pure Node stdlib.
// Objects are stored by their real SHA-1 over "<type> <len>\0" + payload, and pushed
// objects keep their exact payload bytes so clones round-trip byte-for-byte.

import { createHash } from "node:crypto";
import zlib from "node:zlib";
import type { RepoRec } from "./store.ts";

export const ZERO_SHA = "0000000000000000000000000000000000000000";
export const TYPE_NUM: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const TYPE_NAME: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

export function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

export function objectId(typeName: string, payload: Buffer): string {
  const header = Buffer.from(`${typeName} ${payload.length}\0`, "utf8");
  return sha1Hex(Buffer.concat([header, payload]));
}

export function storeObject(repo: RepoRec, typeName: string, payload: Buffer): string {
  const sha = objectId(typeName, payload);
  if (!repo.objects.has(sha)) {
    repo.objects.set(sha, { type: TYPE_NUM[typeName], payload });
  }
  return sha;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  committerTime: number;
}

const commitInfoCache = new WeakMap<Buffer, CommitInfo>();

export function parseCommit(payload: Buffer): CommitInfo {
  const cached = commitInfoCache.get(payload);
  if (cached) return cached;
  const info = parseCommitUncached(payload);
  commitInfoCache.set(payload, info);
  return info;
}

function parseCommitUncached(payload: Buffer): CommitInfo {
  const text = payload.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : "";
  let tree = "";
  const parents: string[] = [];
  let committerTime = 0;
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("committer ")) {
      const parts = line.trim().split(" ");
      const ts = Number(parts[parts.length - 2]);
      if (Number.isFinite(ts)) committerTime = ts;
    }
  }
  return { tree, parents, message, committerTime };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
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

function treeSortKey(entry: TreeEntry): string {
  // Git sorts tree entries by name, with directories compared as if suffixed by "/".
  return entry.mode === "40000" ? `${entry.name}/` : entry.name;
}

export function buildTreePayload(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"));
    parts.push(Buffer.from(entry.sha, "hex"));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {mode, sha}. */
export function flattenTree(repo: RepoRec, treeSha: string, prefix: string, out: Map<string, { mode: string; sha: string }>): void {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 2) return;
  for (const entry of parseTree(obj.payload)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === "40000") flattenTree(repo, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
}

/** Rebuild nested trees from a flat path map; returns the root tree sha. */
export function unflattenTree(repo: RepoRec, files: Map<string, { mode: string; sha: string }>): string {
  interface Node {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], file);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, sha: file.sha });
    for (const [name, dir] of node.dirs) entries.push({ mode: "40000", name, sha: write(dir) });
    return storeObject(repo, "tree", buildTreePayload(entries));
  };
  return write(root);
}

/** All objects reachable from the given tips (commits, their trees/blobs, tag chains). */
export function reachableObjects(repo: RepoRec, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    seen.add(sha);
    if (obj.type === 1) {
      const commit = parseCommit(obj.payload);
      if (commit.tree) stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 2) {
      for (const entry of parseTree(obj.payload)) stack.push(entry.sha);
    } else if (obj.type === 4) {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.payload.toString("utf8"));
      if (match) stack.push(match[1]);
    }
  }
  return seen;
}

/** Commit-only ancestors of a tip (including the tip itself). */
export function commitAncestors(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 1) continue;
    seen.add(sha);
    for (const parent of parseCommit(obj.payload).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // Early-exit DFS: the common fast-forward case (the old tip is the new tip's
  // parent) resolves in one step instead of walking the whole ancestry.
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const sha = stack.pop() as string;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 1) continue;
    for (const parent of parseCommit(obj.payload).parents) stack.push(parent);
  }
  return false;
}

/** BFS generations from the tips: gen 0 = tips, gen n+1 = parents of gen n.
 *  With maxDepth, generations past it are not recorded (callers that only need
 *  shallow generations — a depth-limited fetch — skip the full history walk). */
export function commitGenerations(repo: RepoRec, tips: string[], maxDepth = Number.POSITIVE_INFINITY): Map<string, number> {
  const gen = new Map<string, number>();
  let frontier = [...new Set(tips)];
  for (const tip of frontier) gen.set(tip, 0);
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    depth += 1;
    const next: string[] = [];
    for (const sha of frontier) {
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 1) continue;
      for (const parent of parseCommit(obj.payload).parents) {
        if (!gen.has(parent)) {
          gen.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return gen;
}

/** Peel a (possibly annotated) tag sha to the commit it ultimately points at. */
export function peelToCommit(repo: RepoRec, sha: string): string | null {
  let current = sha;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 1) return current;
    if (obj.type !== 4) return null;
    const match = /^object ([0-9a-f]{40})/m.exec(obj.payload.toString("utf8"));
    if (!match) return null;
    current = match[1];
  }
  return null;
}

// ---------------------------------------------------------------- packfiles

export function buildPack(repo: RepoRec, shas: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  const parts: Buffer[] = [header];
  for (const sha of shas) {
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    // varint: type in bits 4-6 of first byte, size little-endian-ish continuation
    const size = obj.payload.length;
    const bytes: number[] = [];
    let first = (obj.type << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(zlib.deflateSync(obj.payload));
  }
  const body = Buffer.concat(parts);
  const checksum = createHash("sha1").update(body).digest();
  return Buffer.concat([body, checksum]);
}

/** Adler-32 of `data` (the zlib stream trailer is this value, big-endian). */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Exact consumed length of the zlib stream starting at `start` (binary search on inflate). */
function inflateExactSearch(buf: Buffer, start: number): { data: Buffer; next: number } {
  let lo = 1;
  let hi = buf.length - start;
  let best: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = zlib.inflateSync(buf.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = zlib.inflateSync(buf.subarray(start, start + lo));
  return { data, next: start + lo };
}

/**
 * Inflate the zlib stream starting at `start` with a single inflateSync on the
 * remainder (which tolerates trailing bytes), locating the stream's end as the
 * position of its Adler-32 trailer. The end position is not verified here:
 * parsePack checks the pack's own SHA-1 trailer over the consumed bytes, and
 * any mismatch re-parses with the exact binary search.
 */
function inflateAdler(buf: Buffer, start: number): { data: Buffer; next: number } {
  const data = zlib.inflateSync(buf.subarray(start));
  const adler = adler32(data);
  const trailer = Buffer.from([(adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff]);
  const hit = buf.indexOf(trailer, start + 2);
  if (hit < 0) throw new Error("zlib stream trailer not found");
  return { data, next: hit + 4 };
}

export interface ParsedPackObject {
  type: number;
  payload: Buffer;
  baseSha?: string; // for ref-delta
  baseOffset?: number; // for ofs-delta (negative offset from entry start)
  entryStart: number;
}

/** Parse a packfile body. Supports full objects and both delta kinds. */
export function parsePack(buf: Buffer): ParsedPackObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("not a packfile");
  }
  try {
    const { entries, end } = parsePackWith(buf, inflateAdler);
    // The fast path locates stream ends by their Adler-32 trailer without
    // verifying each one; the pack's SHA-1 trailer over everything before it
    // is the verification. A mismatch means a located end was wrong, so fall
    // through to the exact parse below.
    if (end === buf.length - 20) {
      const digest = createHash("sha1").update(buf.subarray(0, end)).digest();
      if (digest.equals(buf.subarray(end, end + 20))) return entries;
    }
  } catch {
    // fast path failed: exact parse below
  }
  return parsePackWith(buf, inflateExactSearch).entries;
}

function parsePackWith(
  buf: Buffer,
  inflate: (buf: Buffer, start: number) => { data: Buffer; next: number },
): { entries: ParsedPackObject[]; end: number } {
  const count = buf.readUInt32BE(8);
  let pos = 12;
  const entries: ParsedPackObject[] = [];
  for (let n = 0; n < count; n++) {
    const entryStart = pos;
    let byte = buf[pos++];
    const type = (byte >> 4) & 0x07;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      shift += 7;
    }
    let baseSha: string | undefined;
    let baseOffset: number | undefined;
    if (type === 6) {
      // ofs-delta: base offset encoding
      let b = buf[pos++];
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = offset;
    } else if (type === 7) {
      baseSha = buf.subarray(pos, pos + 20).toString("hex");
      pos += 20;
    }
    const { data, next } = inflate(buf, pos);
    pos = next;
    entries.push({ type, payload: data, baseSha, baseOffset, entryStart });
  }
  return { entries, end: pos };
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error("delta base size mismatch");
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error("delta target size mismatch");
  return result;
}

/** Resolve parsed pack entries (incl. deltas) into plain objects. */
export function resolvePackEntries(entries: ParsedPackObject[]): Array<{ type: number; payload: Buffer }> {
  const byStart = new Map<number, number>(); // entryStart -> index in resolved array (lazily filled)
  const resolved: Array<{ type: number; payload: Buffer } | null> = entries.map(() => null);
  const resolve = (index: number): { type: number; payload: Buffer } => {
    const existing = resolved[index];
    if (existing) return existing;
    const entry = entries[index];
    let out: { type: number; payload: Buffer };
    if (entry.type === 6) {
      const baseIndex = entries.findIndex((e) => e.entryStart === entry.entryStart - (entry.baseOffset ?? 0));
      if (baseIndex < 0) throw new Error("ofs-delta base not in pack");
      const base = resolve(baseIndex);
      out = { type: base.type, payload: applyDelta(base.payload, entry.payload) };
    } else if (entry.type === 7) {
      // ref-delta against an object already resolved in this pack is handled by the
      // caller seeding `externalBase`; here we can only fail loudly.
      throw new Error("ref-delta requires external base");
    } else {
      out = { type: entry.type, payload: entry.payload };
    }
    resolved[index] = out;
    byStart.set(entry.entryStart, index);
    return out;
  };
  const all: Array<{ type: number; payload: Buffer }> = [];
  for (let i = 0; i < entries.length; i++) all.push(resolve(i));
  return all;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from("0000", "ascii");
export const PKT_DELIM = Buffer.from("0001", "ascii");
export const PKT_RESPONSE_END = Buffer.from("0002", "ascii");

export type Pkt =
  | { kind: "data"; payload: Buffer }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "response-end" };

export class PktReader {
  pos = 0;
  private buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Next packet, or null at end of buffer. */
  next(): Pkt | null {
    if (this.pos + 4 > this.buf.length) return null;
    const header = this.buf.subarray(this.pos, this.pos + 4).toString("ascii");
    const length = Number.parseInt(header, 16);
    if (Number.isNaN(length)) throw new Error("invalid pkt-line header");
    if (length === 0) {
      this.pos += 4;
      return { kind: "flush" };
    }
    if (length === 1) {
      this.pos += 4;
      return { kind: "delim" };
    }
    if (length === 2) {
      this.pos += 4;
      return { kind: "response-end" };
    }
    if (length < 4 || this.pos + length > this.buf.length) throw new Error("truncated pkt-line");
    const payload = this.buf.subarray(this.pos + 4, this.pos + length);
    this.pos += length;
    return { kind: "data", payload };
  }

  /** Remaining raw bytes (e.g. the packfile after the command packets). */
  rest(): Buffer {
    return this.buf.subarray(this.pos);
  }
}

/** Wrap bytes as sideband band-1 packets (with optional band-2 progress text first). */
export function sidebandWrap(data: Buffer, progress?: string): Buffer[] {
  const packets: Buffer[] = [];
  if (progress) {
    const text = Buffer.from(progress, "utf8");
    for (let i = 0; i < text.length; i += 60000) {
      packets.push(pktLine(Buffer.concat([Buffer.from([2]), text.subarray(i, i + 60000)])));
    }
  }
  for (let i = 0; i < data.length; i += 60000) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(i, i + 60000)])));
  }
  if (data.length === 0) {
    packets.push(pktLine(Buffer.from([1])));
  }
  return packets;
}
