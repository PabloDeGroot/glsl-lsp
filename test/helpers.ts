// Test helpers: an in-memory workspace and cursor markers.
import { Builtins, builtinData, getBuiltins, type Environment } from '../server/src/builtins';
import { MemoryFileSystem, parse, Workspace, type FileModel, type Position, type WorkspaceOptions } from '../server/src/core';

export const ROOT = 'file:///ws';

export function uri(path: string): string {
  return `${ROOT}/${path}`;
}

export interface MakeWorkspaceOptions {
  includePaths?: string[];
  /** Environment uniforms / defines (gets a private Builtins instance). */
  environment?: Partial<Environment>;
  shadertoy?: WorkspaceOptions['shadertoy'];
  shaderToyExtension?: boolean;
}

/** Builds a workspace from `{ 'path/in/ws.glsl': text }` and indexes it. */
export function makeWorkspace(files: Record<string, string>, options: MakeWorkspaceOptions = {}) {
  const fs = new MemoryFileSystem(Object.fromEntries(Object.entries(files).map(([p, t]) => [uri(p), t])));
  let builtins = getBuiltins();
  if (options.environment) {
    builtins = new Builtins(builtinData);
    builtins.setEnvironment(options.environment);
  }
  const ws = new Workspace({
    fs,
    builtins,
    roots: [ROOT],
    includePaths: options.includePaths,
    shadertoy: options.shadertoy,
    shaderToyExtension: options.shaderToyExtension,
  });
  ws.indexWorkspaceSync();
  return { ws, fs };
}

/**
 * Strips a `|` cursor marker from `text` and returns the text and the
 * position of the marker.
 */
export function cursor(textWithMarker: string, marker = '|'): { text: string; position: Position; offset: number } {
  const offset = textWithMarker.indexOf(marker);
  if (offset < 0) throw new Error('no cursor marker');
  const text = textWithMarker.slice(0, offset) + textWithMarker.slice(offset + marker.length);
  const before = text.slice(0, offset).split('\n');
  return { text, offset, position: { line: before.length - 1, character: before[before.length - 1].length } };
}

/** Position of the n-th occurrence (0-based) of `needle` in `text`, plus `delta` characters. */
export function posOf(text: string, needle: string, delta = 0, nth = 0): Position {
  let idx = -1;
  for (let i = 0; i <= nth; i++) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`'${needle}' not found`);
  }
  const before = text.slice(0, idx + delta).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

export function parseText(text: string): FileModel {
  return parse(text, uri('test.glsl'));
}
