// URI helpers. All maps in the server are keyed by normalized URI strings
// (`normalizeUri`), so `file:///C:/x`, `file:///c%3A/x` and a raw Windows
// path all end up as the same key.

import * as posix from 'node:path/posix';
import { URI, Utils } from 'vscode-uri';

/** Canonical string form of a URI (file URIs: lower-case drive, encoded colon). */
export function normalizeUri(uri: string): string {
  try {
    const parsed = URI.parse(uri);
    if (parsed.scheme === 'file') return URI.file(parsed.fsPath).toString();
    return parsed.toString();
  } catch {
    return uri;
  }
}

export function fsPathToUri(fsPath: string): string {
  return URI.file(fsPath).toString();
}

export function uriToFsPath(uri: string): string {
  return URI.parse(uri).fsPath;
}

export function isFileUri(uri: string): boolean {
  return uri.startsWith('file:');
}

export function dirnameUri(uri: string): string {
  return Utils.dirname(URI.parse(uri)).toString();
}

export function basenameUri(uri: string): string {
  return Utils.basename(URI.parse(uri));
}

/** True for `/x`, `C:/x`, `C:\x`, `\\server\x`. */
export function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
}

/** Resolves `relPath` (forward or back slashes) against the directory URI `dirUri`. */
export function resolveUri(dirUri: string, relPath: string): string {
  const clean = relPath.replace(/\\/g, '/');
  if (isAbsolutePath(relPath)) return fsPathToUri(relPath);
  return normalizeUri(Utils.resolvePath(URI.parse(dirUri), clean).toString());
}

function driveOf(path: string): string | undefined {
  return /^\/([a-zA-Z]):/.exec(path)?.[1]?.toLowerCase();
}

/**
 * Relative path from directory `fromDirUri` to `toUri` with forward slashes,
 * or undefined when no relative path exists (different scheme, authority or drive).
 */
export function relativePath(fromDirUri: string, toUri: string): string | undefined {
  const from = URI.parse(fromDirUri);
  const to = URI.parse(toUri);
  if (from.scheme !== to.scheme || from.authority !== to.authority) return undefined;
  if (driveOf(from.path) !== driveOf(to.path)) return undefined;
  const rel = posix.relative(from.path, to.path);
  return rel || '.';
}

/** True when `uri` is `dirUri` or lies below it. */
export function isUnder(dirUri: string, uri: string): boolean {
  const rel = relativePath(dirUri, uri);
  return rel !== undefined && rel !== '..' && !rel.startsWith('../') && !isAbsolutePath(rel);
}
