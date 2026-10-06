// Minimal in-memory `vscode` for unit tests of client modules (aliased in
// vitest.config.mts). One document, one visible editor; edits fire
// onDidChangeTextDocument synchronously before the edit promise resolves,
// as the real extension host does.

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}

export class Uri {
  static parse(s: string): { toString(): string } {
    return { toString: () => s };
  }
}

type Listener = (e: unknown) => void;
const listeners: Listener[] = [];
let text = '';
let version = 1;
export const DOC_URI = 'file:///test.glsl';

export const doc = {
  uri: { toString: () => DOC_URI },
  get version() {
    return version;
  },
  offsetAt(p: Position): number {
    const lines = text.split('\n');
    let o = 0;
    for (let i = 0; i < p.line; i++) o += lines[i].length + 1;
    return o + p.character;
  },
  positionAt(o: number): Position {
    const before = text.slice(0, Math.max(0, Math.min(o, text.length))).split('\n');
    return new Position(before.length - 1, before[before.length - 1].length);
  },
  getText(r?: Range): string {
    return r ? text.slice(doc.offsetAt(r.start), doc.offsetAt(r.end)) : text;
  },
};

export function setText(t: string): void {
  text = t;
  version++;
}
export function getText(): string {
  return text;
}

/** Applies an edit as the user would (fires the change event). */
export function userEdit(start: number, end: number, insert: string): void {
  replace(new Range(doc.positionAt(start), doc.positionAt(end)), insert);
}

function replace(r: Range, t: string): void {
  const s = doc.offsetAt(r.start);
  const e = doc.offsetAt(r.end);
  text = text.slice(0, s) + t + text.slice(e);
  version++;
  for (const l of listeners) l({ document: doc, contentChanges: [{ range: r, rangeOffset: s, rangeLength: e - s, text: t }] });
}

export const undoStops: { before: boolean; after: boolean }[] = [];
const editor = {
  document: doc,
  edit: async (cb: (b: { replace: (r: Range, t: string) => void }) => void, o?: { undoStopBefore: boolean; undoStopAfter: boolean }) => {
    await Promise.resolve();
    cb({ replace });
    undoStops.push({ before: !!o?.undoStopBefore, after: !!o?.undoStopAfter });
    return true;
  },
};

export const window = { visibleTextEditors: [editor] };
export const workspace = {
  onDidChangeTextDocument: (l: Listener) => {
    listeners.push(l);
    return { dispose: () => listeners.splice(listeners.indexOf(l), 1) };
  },
  openTextDocument: async () => doc,
  applyEdit: async () => true,
  textDocuments: [doc],
};
export class WorkspaceEdit {
  replace(): void {}
}
