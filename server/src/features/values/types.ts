// Internal types of the value detection (not part of the wire protocol).

import type { FileModel, Token } from '../../core';
import type { ValueKind } from '../../../../shared/valuesProtocol';

/** A significant token; directive bodies (#define, #iUniform default) are spliced into the stream. */
export interface STok extends Token {
  /** -1 for ordinary code, else the index in Analysis.dirs of the directive this token belongs to. */
  region: number;
}

export interface DirInfo {
  kind: 'define' | 'iUniform';
  name: string;
  declaredType?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Offsets of the whole directive. */
  start: number;
  end: number;
  /** Function-like macro: parameter list present. */
  functionLike: boolean;
}

export interface Lit {
  /** Token index of the unary minus (when present) else of the number. */
  startTok: number;
  /** Token index of the number. */
  endTok: number;
  start: number;
  end: number;
  value: number;
  text: string;
  integer: boolean;
}

export interface VecInfo {
  /** Constructor name as written. */
  ctor: string;
  dim: 2 | 3 | 4;
  open: number;
  close: number;
  splat: boolean;
  /** One entry per argument. */
  args: { from: number; to: number; lit?: Lit }[];
}

export interface PaletteInfo {
  shape: 'call' | 'expression';
  /** Spec indices (into Analysis.specs) of a, b, c, d. */
  children: [Spec, Spec, Spec, Spec];
}

export interface Spec {
  kind: Exclude<ValueKind, 'multi'>;
  /** Token index range, inclusive. */
  startTok: number;
  endTok: number;
  start: number;
  end: number;
  /** Not nested in another vec / palette. */
  top: boolean;
  lit?: Lit;
  vec?: VecInfo;
  palette?: PaletteInfo;
  /** Integer literal float spec. */
  integer: boolean;
  /** Role in an iq cosine palette (a/b read as colors, c/d do not). */
  paletteRole?: 'a' | 'b' | 'c' | 'd';
  /** Not in the source (palette without c): one locked component of value 1. */
  implicit?: boolean;
}

export interface FnRange {
  name: string;
  start: number;
  end: number;
}

export interface Analysis {
  model: FileModel;
  seq: STok[];
  dirs: DirInfo[];
  /** Matching bracket token index for ( ) [ ], -1 otherwise. */
  match: Int32Array;
  /** Sorted by start (outer before inner). */
  specs: Spec[];
  specByStart: Map<number, Spec>;
  fns: FnRange[];
  /** Spec start line -> specs. */
  byLine: Map<number, Spec[]>;
}

export interface MultiGroup {
  /** Token range [from, to) of the statement. */
  from: number;
  to: number;
  children: Spec[];
}

import type { Workspace } from '../../core';
import type { ColorsMode } from '../colors';

export interface ValuesEnv {
  getModel(uri: string): FileModel | undefined;
  /** Open document version, or null when the file is only on disk. */
  getVersion(uri: string): number | null;
  /** For resolving an identifier under the cursor to its declaration in another file (#iUniform in an include). */
  workspace: Workspace;
  /** glslLsp.colors.mode: 'off' still detects targets; colorish is then the 'heuristic' answer. */
  colorsMode: ColorsMode;
}
