// File system abstraction so the Workspace can be unit tested with an
// in-memory tree. All paths are URI strings (normalized, see uri.ts).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath, parse as parsePath } from 'node:path';
import { fsPathToUri, normalizeUri, uriToFsPath } from './uri';

export interface ListOptions {
  /** Accept a file by name. */
  acceptFile: (name: string) => boolean;
  /** Skip a directory by name; `uri` is the directory's URI. */
  skipDir: (name: string, uri: string) => boolean;
  /** Stop after this many files. */
  maxFiles: number;
}

export interface FileSystem {
  /** File contents, or undefined if missing/unreadable. */
  readFile(uri: string): string | undefined;
  /** True if a regular file exists at `uri`. */
  exists(uri: string): boolean;
  /** Recursively lists accepted files below `dirUri`. */
  listFiles(dirUri: string, options: ListOptions): string[];
  /** True when paths differing only in case name the same file (Windows, macOS). */
  readonly caseInsensitive?: boolean;
  /** `uri` spelled with the on-disk case of every path segment (only for existing files). */
  canonical?(uri: string): string;
}

/** Strips a leading UTF-8 byte order mark (many Windows editors write one). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export class NodeFileSystem implements FileSystem {
  readonly caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  private readonly dirCache = new Map<string, string[]>();

  readFile(uri: string): string | undefined {
    try {
      return stripBom(readFileSync(uriToFsPath(uri), 'utf8'));
    } catch {
      return undefined;
    }
  }

  canonical(uri: string): string {
    if (!this.caseInsensitive) return uri;
    const path = uriToFsPath(uri);
    const root = parsePath(path).root;
    const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean);
    let cur = root;
    let changed = false;
    for (const part of parts) {
      let hit = this.entryNamed(cur, part, false) ?? this.entryNamed(cur, part, true);
      if (!hit) return uri;
      if (hit !== part) changed = true;
      cur = joinPath(cur, hit);
    }
    return changed ? fsPathToUri(cur) : uri;
  }

  /** Directory entry of `dir` equal to `name` ignoring case (exact match preferred). */
  private entryNamed(dir: string, name: string, refresh: boolean): string | undefined {
    let names = refresh ? undefined : this.dirCache.get(dir);
    if (!names) {
      try {
        names = readdirSync(dir);
      } catch {
        return undefined;
      }
      this.dirCache.set(dir, names);
    }
    if (names.includes(name)) return name;
    const lower = name.toLowerCase();
    return names.find((n) => n.toLowerCase() === lower);
  }

  exists(uri: string): boolean {
    try {
      return statSync(uriToFsPath(uri)).isFile();
    } catch {
      return false;
    }
  }

  listFiles(dirUri: string, options: ListOptions): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (out.length >= options.maxFiles) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= options.maxFiles) return;
        const full = dir + (dir.endsWith('\\') || dir.endsWith('/') ? '' : '/') + e.name;
        if (e.isDirectory()) {
          if (!options.skipDir(e.name, fsPathToUri(full))) walk(full);
        } else if (e.isFile() && options.acceptFile(e.name)) {
          out.push(fsPathToUri(full));
        }
      }
    };
    walk(uriToFsPath(dirUri));
    return out;
  }
}

/** In-memory file system for tests. Keys are normalized URIs. */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  constructor(files: Record<string, string> = {}) {
    for (const [uri, text] of Object.entries(files)) this.set(uri, text);
  }

  set(uri: string, text: string) {
    this.files.set(normalizeUri(uri), text);
  }

  delete(uri: string) {
    this.files.delete(normalizeUri(uri));
  }

  readFile(uri: string): string | undefined {
    const t = this.files.get(normalizeUri(uri));
    return t === undefined ? undefined : stripBom(t);
  }

  exists(uri: string): boolean {
    return this.files.has(normalizeUri(uri));
  }

  listFiles(dirUri: string, options: ListOptions): string[] {
    const prefix = normalizeUri(dirUri).replace(/\/?$/, '/');
    const out: string[] = [];
    for (const uri of this.files.keys()) {
      if (!uri.startsWith(prefix)) continue;
      const parts = uri.slice(prefix.length).split('/');
      const name = parts.pop()!;
      if (parts.some((p, i) => options.skipDir(decodeURIComponent(p), prefix + parts.slice(0, i + 1).join('/')))) continue;
      if (options.acceptFile(decodeURIComponent(name))) out.push(uri);
      if (out.length >= options.maxFiles) break;
    }
    return out;
  }
}
