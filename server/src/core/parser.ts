// Tolerant recursive-descent parser for GLSL.
//
// It does not build a full expression AST. It extracts what editor features
// need: declarations (functions, structs, globals, interface blocks, locals),
// scopes, every identifier occurrence with its role, and call sites with
// argument ranges. It never throws, always makes progress, and recovers from
// half-typed code:
//   - an expression stops at `;`, `{`, `}` or when two operands touch
//     (`foo(1)  float b` -> missing semicolon),
//   - a statement that looks like a function definition (`T name(...) {`)
//     closes the current, unterminated function body,
//   - unclosed calls are kept, with their arguments so far.
//
// Preprocessor branches are not evaluated: directive tokens are skipped and
// every branch is parsed.

import { docAbove, findFileDoc, optionDescription, trailingDoc } from './docs';
import { scanDirectives } from './directives';
import { BASIC_TYPES, canBeIdentifier, CONTROL_KEYWORDS, isKeyword, QUALIFIERS, SOFT_KEYWORDS } from './keywords';
import { isSignificant, lex, type Token } from './lexer';
import type {
  BlockSymbol,
  BracketPair,
  CallSite,
  DocComment,
  FieldSymbol,
  FileModel,
  FoldRegion,
  FunctionSymbol,
  GlobalSymbol,
  Occurrence,
  OccurrenceRole,
  ParameterSymbol,
  ParseIssue,
  Scope,
  ScopeKind,
  StructSymbol,
  TypeRef,
  VariableSymbol,
} from './model';
import { LineIndex } from './text';

const HARD_STOPS = new Set([';', '{', '}']);

/** Storage qualifiers that only exist at file scope. */
const GLOBAL_ONLY_QUALIFIERS = new Set(['uniform', 'in', 'out', 'inout', 'buffer', 'attribute', 'varying', 'shared']);

interface DeclHead {
  startPos: number;
  layout?: string;
  qualifiers: string[];
  type?: TypeRef;
  /** Significant-token index of the type name, if it is an identifier. */
  typePos?: number;
  struct?: StructSymbol;
}

/** Parses a GLSL document into a FileModel. Never throws. */
export function parse(text: string, uri: string, version?: number): FileModel {
  return new Parser(text, uri, version).run();
}

class Parser {
  private readonly lines: LineIndex;
  private readonly tokens: Token[];
  /** Significant tokens (no comments / directives). */
  private readonly sig: Token[];
  /** sig index -> index in `tokens`. */
  private readonly sigFull: number[];
  private pos = 0;
  /** Set when a nested function definition is detected inside a body. */
  private bail = false;
  /** Offsets of `{` without a matching `}`. */
  private unmatchedOpen = new Set<number>();
  /** Number of enclosing function bodies whose `{` is never closed. */
  private unclosedBodies = 0;

  private readonly occurrences: Occurrence[] = [];
  private readonly calls: CallSite[] = [];
  private readonly functions: FunctionSymbol[] = [];
  private readonly structs: StructSymbol[] = [];
  private readonly globals: VariableSymbol[] = [];
  private readonly blocks: BlockSymbol[] = [];
  private readonly issues: ParseIssue[] = [];
  private readonly rootScope: Scope;
  private readonly scan: ReturnType<typeof scanDirectives>;

  constructor(
    private readonly text: string,
    private readonly uri: string,
    private readonly version?: number,
  ) {
    this.lines = new LineIndex(text);
    this.tokens = lex(text);
    this.scan = scanDirectives(this.uri, this.tokens, this.lines);
    const skipped = this.unbalancedBranchRanges();
    this.sig = [];
    this.sigFull = [];
    let k = 0;
    this.tokens.forEach((t, i) => {
      if (!isSignificant(t)) return;
      while (k < skipped.length && skipped[k][1] <= t.start) k++;
      if (k < skipped.length && skipped[k][0] <= t.start) return;
      this.sig.push(t);
      this.sigFull.push(i);
    });
    const stack: number[] = [];
    for (const t of this.sig) {
      if (t.text === '{') stack.push(t.start);
      else if (t.text === '}') stack.pop();
    }
    this.unmatchedOpen = new Set(stack);
    this.rootScope = {
      kind: 'file',
      start: 0,
      end: text.length,
      range: this.lines.range(0, text.length),
      children: [],
      symbols: [],
    };
  }

  /**
   * Offset ranges of `#elif`/`#else` branches to leave out of parsing. When
   * the branches of a conditional do not balance their braces (typically
   * alternative `for (...) {` headers sharing one body), parsing every branch
   * would open too many blocks, so only the first branch is parsed.
   */
  private unbalancedBranchRanges(): [number, number][] {
    const ranges: [number, number][] = [];
    // Innermost groups first, so an outer branch is measured without the
    // alternatives of nested groups that are skipped anyway.
    const groups = this.scan.conditionals
      .filter((block) => block.endif && block.branches.length >= 3) // need at least #if, #else, #endif
      .sort((x, y) => x.endif!.start - x.branches[0].start - (y.endif!.start - y.branches[0].start));
    const skipped = (offset: number) => ranges.some((r) => r[0] <= offset && offset < r[1]);
    for (const block of groups) {
      const b = [...block.branches, block.endif!];
      let unbalanced = false;
      for (let i = 0; i + 1 < b.length && !unbalanced; i++) {
        let delta = 0;
        for (let t = b[i].tokenIndex + 1; t < b[i + 1].tokenIndex; t++) {
          const tok = this.tokens[t];
          if (tok.text !== '{' && tok.text !== '}') continue;
          if (skipped(tok.start)) continue;
          delta += tok.text === '{' ? 1 : -1;
        }
        unbalanced = delta !== 0;
      }
      if (unbalanced) ranges.push([block.branches[1].start, block.endif!.start]);
    }
    // Sort and merge (nested groups may overlap).
    ranges.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  run(): FileModel {
    const scan = this.scan;
    try {
      while (this.pos < this.sig.length) {
        const before = this.pos;
        this.bail = false;
        this.parseExternalDeclaration();
        if (this.pos === before) this.pos++;
      }
    } catch (err) {
      // Defensive: the parser is designed not to throw, but a bug must never
      // take the server down. Keep whatever was collected so far.
      this.issue(`internal parser error: ${(err as Error).message}`, this.sig.length ? this.sig.length - 1 : 0);
    }

    // Merge directive and code occurrences, remapping index references.
    const parserOccs = this.occurrences;
    const all = [...scan.occurrences, ...parserOccs].sort((a, b) => a.start - b.start);
    const indexOf = new Map<Occurrence, number>();
    all.forEach((o, i) => indexOf.set(o, i));
    for (const o of parserOccs) {
      if (o.receiver !== undefined) o.receiver = indexOf.get(parserOccs[o.receiver]);
    }
    for (const c of this.calls) {
      if (c.occurrence !== undefined) c.occurrence = indexOf.get(parserOccs[c.occurrence]);
    }

    const fileDoc = findFileDoc(this.tokens, this.lines);
    const macros = scan.macros;
    const globals = [...scan.globals, ...this.globals].sort((a, b) => a.nameOffset - b.nameOffset);
    if (fileDoc?.style === 'yaml') this.applyFileDoc(fileDoc, macros);

    const symbols: GlobalSymbol[] = [...this.functions, ...this.structs, ...globals, ...this.blocks, ...macros].sort(
      (a, b) => a.nameOffset - b.nameOffset,
    );

    const brackets = this.computeBrackets();
    return {
      uri: this.uri,
      version: this.version,
      text: this.text,
      lines: this.lines,
      tokens: this.tokens,
      directives: scan.directives,
      includes: scan.includes,
      conditionals: scan.conditionals,
      glslVersion: scan.glslVersion,
      shadertoy: { ...scan.shadertoy, hasMainImage: this.functions.some((f) => f.name === 'mainImage') },
      symbols,
      functions: this.functions,
      structs: this.structs,
      globals,
      macros,
      blocks: this.blocks,
      rootScope: this.rootScope,
      occurrences: all,
      calls: this.calls,
      fileDoc,
      folding: this.computeFolding(scan, brackets),
      brackets,
      issues: this.issues,
    };
  }

  // ------------------------------------------------------------ token helpers

  private peek(k = 0): Token | undefined {
    return this.sig[this.pos + k];
  }

  private at(text: string, k = 0): boolean {
    return this.sig[this.pos + k]?.text === text;
  }

  private isIdent(k = 0): boolean {
    const t = this.sig[this.pos + k];
    return !!t && t.kind === 'ident' && canBeIdentifier(t.text);
  }

  private accept(text: string): boolean {
    if (this.at(text)) {
      this.pos++;
      return true;
    }
    return false;
  }

  /** End offset of the last consumed token. */
  private lastEnd(): number {
    return this.pos > 0 ? this.sig[Math.min(this.pos, this.sig.length) - 1].end : 0;
  }

  private issue(message: string, sigIndex = this.pos) {
    if (this.issues.length > 50) return;
    const t = this.sig[Math.min(sigIndex, this.sig.length - 1)];
    const start = t ? t.start : this.text.length;
    const end = t ? t.end : this.text.length;
    this.issues.push({ message, range: this.lines.range(start, end) });
  }

  private expect(text: string) {
    if (!this.accept(text)) {
      const prev = this.sig[this.pos - 1];
      this.issues.length <= 50 &&
        this.issues.push({
          message: `expected '${text}'`,
          range: this.lines.range(prev ? prev.end : 0, prev ? prev.end : 0),
        });
    }
  }

  private range(startOffset: number, endOffset: number) {
    return this.lines.range(startOffset, endOffset);
  }

  private addOcc(tok: Token, role: OccurrenceRole, extra?: Partial<Occurrence>): number {
    this.occurrences.push({
      name: tok.text,
      role,
      start: tok.start,
      end: tok.end,
      range: this.range(tok.start, tok.end),
      ...extra,
    });
    return this.occurrences.length - 1;
  }

  /** Skips a balanced group starting at the current opener; returns its text. */
  private skipBalanced(): string {
    const open = this.peek();
    if (!open) return '';
    const close = open.text === '(' ? ')' : open.text === '[' ? ']' : '}';
    const start = open.start;
    let depth = 0;
    while (this.pos < this.sig.length) {
      const t = this.sig[this.pos++];
      if (t.text === open.text) depth++;
      else if (t.text === close && --depth === 0) break;
    }
    return this.text.slice(start, this.lastEnd());
  }

  private skipToSemicolon() {
    let depth = 0;
    while (this.pos < this.sig.length) {
      const t = this.sig[this.pos];
      if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
      else if (t.text === ')' || t.text === ']' || t.text === '}') {
        if (depth === 0) return;
        depth--;
      } else if (t.text === ';' && depth === 0) {
        this.pos++;
        return;
      }
      this.pos++;
    }
  }

  private docFor(sigIndex: number): DocComment | undefined {
    const full = this.sigFull[sigIndex];
    return full === undefined ? undefined : docAbove(this.tokens, full, this.lines);
  }

  private trailing(sigIndex: number, mode: 'variable' | 'parameter'): DocComment | undefined {
    const full = this.sigFull[sigIndex];
    return full === undefined ? undefined : trailingDoc(this.tokens, full, this.lines, mode);
  }

  // ------------------------------------------------------------ declarations

  /** Qualifiers, layout and type at the current position. Does not record occurrences. */
  private parseDeclHead(scope: Scope): DeclHead {
    const head: DeclHead = { startPos: this.pos, qualifiers: [] };
    for (;;) {
      const t = this.peek();
      if (!t) return head;
      if (t.text === 'layout' && this.at('(', 1)) {
        this.pos++;
        head.layout = 'layout' + this.skipBalanced();
        continue;
      }
      const next = this.peek(1);
      if (QUALIFIERS.has(t.text) && (!SOFT_KEYWORDS.has(t.text) || next?.kind === 'ident')) {
        head.qualifiers.push(t.text);
        this.pos++;
        continue;
      }
      // Macro used as a qualifier, e.g. LYGIA's `HIGHP float x` / `HIGHP in vec2 st`.
      if (this.isMacroQualifier()) {
        head.qualifiers.push(t.text);
        this.addOcc(t, 'reference');
        this.pos++;
        continue;
      }
      break;
    }
    if (this.at('struct')) {
      head.struct = this.parseStruct(scope);
      if (head.struct) head.type = { name: head.struct.name || '(anonymous struct)', range: head.struct.nameRange };
      return head;
    }
    const t = this.peek();
    if (t && t.kind === 'ident' && !CONTROL_KEYWORDS.has(t.text) && t.text !== 'precision') {
      head.typePos = this.pos;
      this.pos++;
      const type: TypeRef = { name: t.text, range: this.range(t.start, t.end) };
      if (this.at('[')) type.array = this.skipBalancedArray(scope);
      head.type = type;
    }
    return head;
  }

  /** Parses `[expr][expr]...`, recording identifiers inside, returns the text. */
  private skipBalancedArray(scope: Scope): string {
    let out = '';
    while (this.at('[')) {
      const start = this.peek()!.start;
      this.pos++;
      this.parseExpr(scope, [']']);
      this.accept(']');
      out += this.text.slice(start, this.lastEnd()).replace(/\s+/g, '');
    }
    return out;
  }

  private recordHeadType(head: DeclHead) {
    if (head.typePos === undefined) return;
    const t = this.sig[head.typePos];
    if (!BASIC_TYPES.has(t.text)) this.addOcc(t, 'type');
  }

  private parseExternalDeclaration() {
    const t = this.peek()!;
    if (t.text === ';') {
      this.pos++;
      return;
    }
    if (t.text === 'precision') {
      this.skipToSemicolon();
      return;
    }
    if (t.text === '}' || t.text === ')' || t.text === ']') {
      this.issue(`unexpected '${t.text}'`);
      this.pos++;
      return;
    }
    if (t.text === '{') {
      // Stray block at file scope: parse it as a block so its contents are still navigable.
      this.parseBlock(this.rootScope, 'block');
      return;
    }
    if (t.kind !== 'ident') {
      // Expression-ish garbage at file scope.
      this.parseExpr(this.rootScope, []);
      if (!this.accept(';') && this.pos < this.sig.length && !HARD_STOPS.has(this.peek()!.text)) this.pos++;
      return;
    }

    // Interface block: `uniform Name { ... } inst;`
    const head = this.parseDeclHead(this.rootScope);
    if (
      !head.struct &&
      head.qualifiers.length &&
      head.typePos !== undefined &&
      !head.type?.array &&
      this.at('{')
    ) {
      this.parseInterfaceBlock(head);
      return;
    }
    if (!head.type) {
      // `invariant gl_Position;`, `layout(...) in;` or garbage.
      if (head.qualifiers.length || head.layout) {
        while (this.isIdent()) this.addOcc(this.sig[this.pos++], 'reference');
        this.accept(';');
        return;
      }
      this.parseExpr(this.rootScope, []);
      this.accept(';');
      return;
    }
    // Plain expression/macro invocation at file scope: `FOO(x);`
    if (!head.struct && !head.qualifiers.length && head.typePos !== undefined && this.at('(')) {
      this.pos = head.startPos;
      this.parseExpr(this.rootScope, []);
      this.accept(';');
      return;
    }
    this.recordHeadType(head);
    if (this.isIdent() && this.at('(', 1)) {
      this.parseFunction(head);
      return;
    }
    if (head.struct && this.accept(';')) return;
    this.parseDeclarators(head, this.rootScope, 'global');
  }

  private parseFunction(head: DeclHead) {
    const nameTok = this.sig[this.pos++];
    const openTok = this.sig[this.pos];
    const fn: FunctionSymbol = {
      kind: 'function',
      name: nameTok.text,
      uri: this.uri,
      range: this.range(this.sig[head.startPos].start, nameTok.end),
      nameRange: this.range(nameTok.start, nameTok.end),
      nameOffset: nameTok.start,
      returnType: head.type!,
      qualifiers: head.qualifiers,
      params: [],
      isPrototype: true,
      paramsRange: this.range(openTok.start, openTok.end),
      origin: 'declaration',
    };
    fn.doc = this.docFor(head.startPos);
    this.addOcc(nameTok, 'declaration', { symbol: fn });

    const scope = this.newScope(this.rootScope, 'function', openTok.start);
    scope.function = fn;
    fn.scope = scope;
    this.pos++; // (
    this.parseParams(fn, scope);
    fn.paramsRange = this.range(openTok.start, this.lastEnd());

    if (this.at('{')) {
      fn.isPrototype = false;
      const bodyStart = this.peek()!.start;
      this.pos++;
      const unclosed = this.unmatchedOpen.has(bodyStart);
      if (unclosed) this.unclosedBodies++;
      this.parseStatements(scope);
      if (unclosed) this.unclosedBodies--;
      const closed = this.accept('}');
      if (!closed) this.issue(`unterminated body of '${fn.name}'`, this.pos - 1);
      fn.bodyRange = this.range(bodyStart, this.lastEnd());
    } else {
      this.expect(';');
    }
    fn.range = this.range(this.sig[head.startPos].start, this.lastEnd());
    this.closeScope(scope);
    this.functions.push(fn);
  }

  private parseParams(fn: FunctionSymbol, scope: Scope) {
    if (this.at('void') && this.at(')', 1)) {
      this.pos += 2;
      return;
    }
    let index = 0;
    while (this.pos < this.sig.length) {
      if (this.accept(')')) return;
      const t = this.peek()!;
      if (t.text === '{' || t.text === ';' || t.text === '}') return; // unclosed
      if (this.looksLikeFunctionDefinition()) {
        // Unclosed parameter list followed by the next function definition.
        this.issue("expected ')'", Math.max(0, this.pos - 1));
        return;
      }
      const head = this.parseDeclHead(scope);
      if (!head.type) {
        // Garbage inside the parameter list: skip one token.
        if (!this.at(',') && !this.at(')')) this.pos++;
      } else {
        this.recordHeadType(head);
        let nameTok: Token | undefined;
        let type = head.type;
        if (this.isIdent()) {
          nameTok = this.sig[this.pos++];
          if (this.at('[')) type = { ...type, array: (type.array ?? '') + this.skipBalancedArray(scope) };
        }
        const startTok = this.sig[head.startPos];
        const param: ParameterSymbol = {
          kind: 'parameter',
          name: nameTok?.text ?? '',
          uri: this.uri,
          range: this.range(startTok.start, this.lastEnd()),
          nameRange: nameTok ? this.range(nameTok.start, nameTok.end) : this.range(startTok.start, this.lastEnd()),
          nameOffset: nameTok?.start ?? startTok.start,
          type,
          qualifiers: head.qualifiers,
          index: index++,
          origin: 'declaration',
        };
        param.doc = this.trailing(this.pos - 1, 'parameter') ?? this.docFor(head.startPos);
        fn.params.push(param);
        if (nameTok) {
          scope.symbols.push(param);
          this.addOcc(nameTok, 'declaration', { symbol: param });
        }
      }
      if (!this.accept(',')) {
        if (!this.accept(')')) this.issue("expected ')'");
        return;
      }
    }
  }

  /** `struct Name { fields }` — returns the symbol; declarators after `}` are left to the caller. */
  private parseStruct(scope: Scope): StructSymbol | undefined {
    const structPos = this.pos;
    this.pos++; // struct
    const nameTok = this.isIdent() ? this.sig[this.pos++] : undefined;
    const startTok = this.sig[structPos];
    const sym: StructSymbol = {
      kind: 'struct',
      name: nameTok?.text ?? '',
      uri: this.uri,
      range: this.range(startTok.start, this.lastEnd()),
      nameRange: nameTok ? this.range(nameTok.start, nameTok.end) : this.range(startTok.start, startTok.end),
      nameOffset: nameTok?.start ?? startTok.start,
      fields: [],
      origin: 'declaration',
    };
    sym.doc = this.docFor(structPos);
    if (nameTok) this.addOcc(nameTok, 'declaration', { symbol: sym });
    if (this.at('{')) {
      const bodyStart = this.peek()!.start;
      this.pos++;
      sym.fields = this.parseFieldList(sym.name, scope, this.unmatchedOpen.has(bodyStart));
      this.expect('}');
      sym.bodyRange = this.range(bodyStart, this.lastEnd());
    }
    sym.range = this.range(startTok.start, this.lastEnd());
    if (scope !== this.rootScope) {
      sym.local = true;
      for (const f of sym.fields) f.parentKey = `@${sym.nameOffset}`;
    }
    if (nameTok) {
      if (scope === this.rootScope) this.structs.push(sym);
      else scope.symbols.push(sym);
    }
    return sym;
  }

  /** Fields until `}` (not consumed). `unclosed`: the body's `{` has no matching `}`. */
  private parseFieldList(parent: string, scope: Scope, unclosed = false): FieldSymbol[] {
    const fields: FieldSymbol[] = [];
    if (unclosed) this.unclosedBodies++;
    while (this.pos < this.sig.length && !this.at('}')) {
      // An unclosed struct/block followed by a function or a file-scope-only
      // declaration (`uniform`, `const` at column 0...): leave it alone.
      if (this.looksLikeFunctionDefinition()) break;
      if (unclosed && this.looksLikeGlobalDeclaration()) break;
      const before = this.pos;
      const head = this.parseDeclHead(scope);
      if (!head.type) {
        if (this.pos === before) this.pos++;
        continue;
      }
      this.recordHeadType(head);
      while (this.isIdent()) {
        const nameTok = this.sig[this.pos++];
        let type = head.type;
        if (this.at('[')) type = { ...type, array: (type.array ?? '') + this.skipBalancedArray(scope) };
        const field: FieldSymbol = {
          kind: 'field',
          name: nameTok.text,
          uri: this.uri,
          range: this.range(this.sig[head.startPos].start, this.lastEnd()),
          nameRange: this.range(nameTok.start, nameTok.end),
          nameOffset: nameTok.start,
          type,
          qualifiers: head.qualifiers,
          parent,
          origin: 'declaration',
        };
        field.doc = this.docFor(head.startPos) ?? this.trailing(this.pos - 1, 'variable');
        fields.push(field);
        this.addOcc(nameTok, 'declaration', { symbol: field });
        if (!this.accept(',')) break;
      }
      if (!this.accept(';')) {
        if (this.at('}')) break;
        if (this.pos === before) this.pos++;
      }
    }
    if (unclosed) this.unclosedBodies--;
    return fields;
  }

  private parseInterfaceBlock(head: DeclHead) {
    const nameTok = this.sig[head.typePos!];
    const startTok = this.sig[head.startPos];
    const block: BlockSymbol = {
      kind: 'block',
      name: nameTok.text,
      uri: this.uri,
      range: this.range(startTok.start, nameTok.end),
      nameRange: this.range(nameTok.start, nameTok.end),
      nameOffset: nameTok.start,
      qualifiers: head.qualifiers,
      layout: head.layout,
      fields: [],
      origin: 'declaration',
    };
    block.doc = this.docFor(head.startPos);
    this.addOcc(nameTok, 'declaration', { symbol: block });
    const bodyStart = this.peek()!.start;
    this.pos++; // {
    block.fields = this.parseFieldList(block.name, this.rootScope, this.unmatchedOpen.has(bodyStart));
    this.expect('}');
    block.bodyRange = this.range(bodyStart, this.lastEnd());
    if (this.isIdent()) {
      const inst = this.sig[this.pos++];
      block.instanceName = inst.text;
      const type: TypeRef = { name: block.name };
      if (this.at('[')) type.array = this.skipBalancedArray(this.rootScope);
      const v: VariableSymbol = {
        kind: 'variable',
        name: inst.text,
        uri: this.uri,
        range: this.range(startTok.start, this.lastEnd()),
        nameRange: this.range(inst.start, inst.end),
        nameOffset: inst.start,
        type,
        qualifiers: head.qualifiers,
        storage: 'global',
        layout: head.layout,
        doc: block.doc,
        origin: 'declaration',
      };
      this.globals.push(v);
      this.addOcc(inst, 'declaration', { symbol: v });
    }
    this.expect(';');
    block.range = this.range(startTok.start, this.lastEnd());
    this.blocks.push(block);
  }

  /** Declarators after a parsed head: `a = 1.0, b[2], c;` */
  private parseDeclarators(head: DeclHead, scope: Scope, storage: 'global' | 'local') {
    const startTok = this.sig[head.startPos];
    const declared: VariableSymbol[] = [];
    while (this.isIdent()) {
      const nameTok = this.sig[this.pos++];
      let type = head.type!;
      if (this.at('[')) type = { ...type, array: (type.array ?? '') + this.skipBalancedArray(scope) };
      const v: VariableSymbol = {
        kind: 'variable',
        name: nameTok.text,
        uri: this.uri,
        range: this.range(startTok.start, nameTok.end),
        nameRange: this.range(nameTok.start, nameTok.end),
        nameOffset: nameTok.start,
        type,
        qualifiers: head.qualifiers,
        storage,
        layout: head.layout,
        origin: 'declaration',
      };
      this.addOcc(nameTok, 'declaration', { symbol: v });
      if (this.accept('=')) {
        const initPos = this.pos;
        this.parseExpr(scope, [','], true);
        if (this.pos > initPos) {
          const s = this.sig[initPos].start;
          const e = this.lastEnd();
          v.initializer = this.text.slice(s, e);
          v.initializerRange = this.range(s, e);
        }
      }
      v.visibleFrom = this.lastEnd();
      declared.push(v);
      if (storage === 'global') this.globals.push(v);
      else scope.symbols.push(v);
      if (!this.accept(',')) break;
    }
    const nameEndPos = this.pos - 1;
    if (!this.accept(';')) this.issue("expected ';'", Math.max(0, this.pos - 1));
    const above = this.docFor(head.startPos);
    const trail = this.trailing(nameEndPos, 'variable');
    for (const v of declared) {
      v.range = this.range(startTok.start, this.lastEnd());
      v.doc = above ?? trail;
    }
  }

  // ------------------------------------------------------------ statements

  private newScope(parent: Scope, kind: ScopeKind, start: number): Scope {
    const scope: Scope = { kind, start, end: start, range: this.range(start, start), parent, children: [], symbols: [] };
    parent.children.push(scope);
    return scope;
  }

  private closeScope(scope: Scope) {
    scope.end = Math.max(scope.start, this.lastEnd());
    scope.range = this.range(scope.start, scope.end);
  }

  /** Statements until `}` (not consumed), EOF, or bail. */
  private parseStatements(scope: Scope) {
    while (this.pos < this.sig.length && !this.bail && !this.at('}')) {
      const before = this.pos;
      this.parseStatement(scope);
      if (this.pos === before && !this.bail && !this.at('}')) this.pos++;
    }
  }

  private parseBlock(parent: Scope, kind: ScopeKind) {
    const open = this.peek()!;
    const scope = this.newScope(parent, kind, open.start);
    this.pos++;
    const unclosed = this.unmatchedOpen.has(open.start);
    if (unclosed) this.unclosedBodies++;
    this.parseStatements(scope);
    if (unclosed) this.unclosedBodies--;
    if (!this.bail) this.expect('}');
    this.closeScope(scope);
  }

  private parseParenExpr(scope: Scope) {
    if (!this.accept('(')) return;
    this.parseExpr(scope, [')']);
    this.expect(')');
  }

  private parseStatement(scope: Scope) {
    const t = this.peek();
    if (!t) return;
    switch (t.text) {
      case '{':
        this.parseBlock(scope, 'block');
        return;
      case ';':
        this.pos++;
        return;
      case '}':
        return;
      case 'if':
        this.pos++;
        this.parseParenExpr(scope);
        this.parseStatement(scope);
        if (this.accept('else')) this.parseStatement(scope);
        return;
      case 'while':
      case 'switch':
        this.pos++;
        this.parseParenExpr(scope);
        this.parseStatement(scope);
        return;
      case 'for': {
        const forScope = this.newScope(scope, 'for', t.start);
        this.pos++;
        if (this.accept('(')) {
          if (!this.accept(';')) {
            if (this.isDeclarationStart()) this.parseLocalDeclaration(forScope);
            else {
              this.parseExpr(forScope, [')']);
              this.expect(';');
            }
          }
          if (!this.accept(';')) {
            this.parseExpr(forScope, [')']);
            this.expect(';');
          }
          this.parseExpr(forScope, [')']);
          this.expect(')');
        }
        if (!this.bail) this.parseStatement(forScope);
        this.closeScope(forScope);
        return;
      }
      case 'do':
        this.pos++;
        this.parseStatement(scope);
        if (this.accept('while')) this.parseParenExpr(scope);
        this.expect(';');
        return;
      case 'return':
        this.pos++;
        this.parseExpr(scope, []);
        this.expect(';');
        return;
      case 'break':
      case 'continue':
      case 'discard':
        this.pos++;
        this.expect(';');
        return;
      case 'case':
        this.pos++;
        this.parseExpr(scope, [':']);
        this.expect(':');
        return;
      case 'default':
        this.pos++;
        this.expect(':');
        return;
      case 'else':
        this.pos++;
        return;
      case 'precision':
        this.skipToSemicolon();
        return;
    }
    if (this.looksLikeFunctionDefinition() || this.looksLikeGlobalDeclaration()) {
      this.bail = true;
      return;
    }
    if (this.isDeclarationStart()) {
      this.parseLocalDeclaration(scope);
      return;
    }
    this.parseExpr(scope, []);
    this.expect(';');
  }

  private parseLocalDeclaration(scope: Scope) {
    const head = this.parseDeclHead(scope);
    if (!head.type) {
      this.skipToSemicolon();
      return;
    }
    this.recordHeadType(head);
    if (head.struct && this.accept(';')) return;
    this.parseDeclarators(head, scope, 'local');
  }

  /** An upper-case identifier followed by a qualifier, a basic type, or `Type name`. */
  private isMacroQualifier(): boolean {
    const t = this.peek();
    const n = this.peek(1);
    if (!t || !n || t.kind !== 'ident' || isKeyword(t.text) || !/^[A-Z_][A-Z0-9_]*$/.test(t.text)) return false;
    if (n.kind !== 'ident') return false;
    if (BASIC_TYPES.has(n.text) || (QUALIFIERS.has(n.text) && !SOFT_KEYWORDS.has(n.text))) return true;
    const nn = this.peek(2);
    // `MACRO Type name`: three identifiers in a row only happen with a qualifier macro.
    return !isKeyword(n.text) && nn?.kind === 'ident' && canBeIdentifier(nn.text);
  }

  private isDeclarationStart(): boolean {
    const t = this.peek();
    if (!t) return false;
    if (SOFT_KEYWORDS.has(t.text) && this.peek(1)?.kind !== 'ident') return false; // `sample = ...`
    if (QUALIFIERS.has(t.text) || t.text === 'layout' || t.text === 'struct') return true;
    if (t.kind !== 'ident' || CONTROL_KEYWORDS.has(t.text)) return false;
    const n = this.peek(1);
    if (!n) return BASIC_TYPES.has(t.text);
    if (n.text === '[') {
      // `float[3] a` vs `a[i] = ...` / `float[](...)`
      let i = this.pos + 1;
      let depth = 0;
      for (; i < this.sig.length; i++) {
        if (this.sig[i].text === '[') depth++;
        else if (this.sig[i].text === ']' && --depth === 0) {
          if (this.sig[i + 1]?.text !== '[') break;
        } else if (HARD_STOPS.has(this.sig[i].text)) return false;
      }
      const after = this.sig[i + 1];
      return !!after && after.kind === 'ident' && canBeIdentifier(after.text);
    }
    if (BASIC_TYPES.has(t.text)) return n.text !== '(' && n.text !== '.';
    return (n.kind === 'ident' && canBeIdentifier(n.text)) || BASIC_TYPES.has(n.text) || QUALIFIERS.has(n.text);
  }

  /**
   * A declaration that cannot appear inside a function body: storage
   * qualifiers only valid at file scope (`uniform`, `in`, `out`, `layout`...)
   * or, while the enclosing body is unclosed, `struct`/`const` at column 0.
   */
  private looksLikeGlobalDeclaration(): boolean {
    const t = this.peek();
    if (!t || t.kind !== 'ident') return false;
    if (GLOBAL_ONLY_QUALIFIERS.has(t.text) && this.peek(1)?.kind === 'ident') return true;
    if (t.text === 'layout' && this.at('(', 1)) return true;
    if ((t.text === 'struct' || t.text === 'const') && this.lines.positionAt(t.start).character === 0) {
      return this.unclosedBodies > 0;
    }
    return false;
  }

  /** Upper-case macro used as a qualifier at significant index `i` (see isMacroQualifier). */
  private isMacroQualifierAt(i: number): boolean {
    const save = this.pos;
    this.pos = i;
    const r = this.isMacroQualifier();
    this.pos = save;
    return r;
  }

  /** `T name(...) {` at the current position (cannot be a local statement). */
  private looksLikeFunctionDefinition(): boolean {
    let i = this.pos;
    while (this.sig[i] && (QUALIFIERS.has(this.sig[i].text) || this.isMacroQualifierAt(i))) i++;
    const type = this.sig[i];
    if (!type || type.kind !== 'ident' || CONTROL_KEYWORDS.has(type.text)) return false;
    i++;
    const name = this.sig[i];
    if (!name || name.kind !== 'ident' || !canBeIdentifier(name.text)) return false;
    if (this.sig[++i]?.text !== '(') return false;
    let depth = 0;
    for (; i < this.sig.length; i++) {
      const s = this.sig[i].text;
      if (s === '(') depth++;
      else if (s === ')') {
        if (--depth === 0) break;
      } else if (HARD_STOPS.has(s)) return false;
    }
    return this.sig[i + 1]?.text === '{';
  }

  // ------------------------------------------------------------ expressions

  /**
   * Consumes an expression, recording occurrences and calls. Stops (without
   * consuming) at `;`, `}`, `{` (unless `allowBrace` for initializer lists),
   * an unbalanced `)`/`]`, any token in `stops` at depth 0, or when two
   * operands touch (missing semicolon).
   */
  private parseExpr(scope: Scope, stops: string[], allowBrace = false) {
    let prevOperand = false;
    let lastOcc: number | undefined;
    while (this.pos < this.sig.length && !this.bail) {
      const t = this.sig[this.pos];
      const s = t.text;
      if (stops.includes(s)) return;
      if (s === ';' || s === '}' || s === ')' || s === ']') return;
      if (s === '{') {
        if (!allowBrace) return;
        this.pos++;
        while (this.pos < this.sig.length && !this.at('}') && !this.at(';')) {
          const before = this.pos;
          this.parseExpr(scope, [','], true);
          if (!this.accept(',') && this.pos === before) break;
        }
        this.accept('}');
        prevOperand = true;
        lastOcc = undefined;
        continue;
      }
      if (t.kind === 'ident' || t.kind === 'number' || t.kind === 'string') {
        if (prevOperand) return; // two operands touching: missing ';' or ','
        prevOperand = true;
        if (t.kind !== 'ident' || s === 'true' || s === 'false') {
          this.pos++;
          lastOcc = undefined;
          continue;
        }
        if ((QUALIFIERS.has(s) && !SOFT_KEYWORDS.has(s)) || CONTROL_KEYWORDS.has(s) || s === 'struct') return;
        // Array constructor `float[3](...)`.
        if (this.at('[', 1) && BASIC_TYPES.has(s)) {
          this.pos++;
          this.skipBalancedArray(scope);
          lastOcc = this.at('(') ? this.parseCallArgs(scope, t, true) : undefined;
          continue;
        }
        if (this.at('(', 1)) {
          lastOcc = this.parseCall(scope);
          continue;
        }
        if (BASIC_TYPES.has(s)) {
          this.pos++;
          lastOcc = undefined;
          continue;
        }
        lastOcc = this.addOcc(t, 'reference');
        this.pos++;
        continue;
      }
      if (s === '.') {
        this.pos++;
        const m = this.peek();
        if (m && m.kind === 'ident') {
          const receiver = prevOperand ? lastOcc : undefined;
          const idx = this.addOcc(m, 'member', receiver !== undefined ? { receiver } : undefined);
          this.pos++;
          if (this.at('(')) {
            // Method call, e.g. arr.length()
            this.parseCallArgs(scope, m, false, idx);
          }
          lastOcc = idx;
        }
        prevOperand = true;
        continue;
      }
      if (s === '(') {
        if (prevOperand) return;
        this.pos++;
        this.parseExpr(scope, [')']);
        this.expect(')');
        prevOperand = true;
        lastOcc = undefined;
        continue;
      }
      if (s === '[') {
        this.pos++;
        this.parseExpr(scope, [']']);
        this.expect(']');
        prevOperand = true;
        // keep lastOcc: `arr[i].field` resolves through arr's element type
        continue;
      }
      if (s === '++' || s === '--') {
        this.pos++;
        continue;
      }
      // Binary/unary operator, ',' (when not a stop), '?', ':'...
      this.pos++;
      prevOperand = false;
      lastOcc = undefined;
    }
  }

  /** At `name (`. Returns the callee occurrence index (if any). */
  private parseCall(scope: Scope): number | undefined {
    const nameTok = this.sig[this.pos++];
    return this.parseCallArgs(scope, nameTok, BASIC_TYPES.has(nameTok.text));
  }

  /** At `(` with the callee already consumed. */
  private parseCallArgs(scope: Scope, nameTok: Token, isConstructor: boolean, existingOcc?: number): number | undefined {
    const open = this.sig[this.pos++];
    const call: CallSite = {
      name: nameTok.text,
      nameRange: this.range(nameTok.start, nameTok.end),
      openParen: open.start,
      range: this.range(nameTok.start, open.end),
      args: [],
      commas: [],
      isConstructor,
    };
    const callIndex = this.calls.length;
    this.calls.push(call);
    let occIndex = existingOcc;
    if (occIndex === undefined && !isConstructor) occIndex = this.addOcc(nameTok, 'call', { call: callIndex });
    else if (occIndex !== undefined) this.occurrences[occIndex].call = callIndex;
    call.occurrence = occIndex;

    if (this.at(')')) {
      call.closeParen = this.sig[this.pos].start;
      this.pos++;
    } else {
      while (this.pos < this.sig.length && !this.bail) {
        const startPos = this.pos;
        this.parseExpr(scope, [',', ')']);
        if (this.pos > startPos) call.args.push(this.range(this.sig[startPos].start, this.lastEnd()));
        const t = this.peek();
        if (t?.text === ',') {
          if (this.pos === startPos) call.args.push(this.range(t.start, t.start));
          call.commas.push(t.start);
          this.pos++;
          if (this.at(')')) {
            const close = this.peek()!;
            call.args.push(this.range(close.start, close.start));
          }
          continue;
        }
        if (t?.text === ')') {
          call.closeParen = t.start;
          this.pos++;
        }
        break;
      }
    }
    call.range = this.range(nameTok.start, this.lastEnd());
    return occIndex;
  }

  // ------------------------------------------------------------ post-processing

  /** LYGIA: the file's YAML block documents symbols without their own doc. */
  private applyFileDoc(fileDoc: DocComment, macros: FileModel['macros']) {
    const inherited: DocComment = { ...fileDoc, inherited: true };
    for (const fn of this.functions) fn.doc ??= inherited;
    for (const st of this.structs) st.doc ??= inherited;
    for (const m of macros) {
      if (m.isIncludeGuard) continue;
      const option = fileDoc.yaml && optionDescription(fileDoc.yaml, m.name);
      if (option && (!m.doc || m.doc.inherited || m.doc.style === 'yaml')) {
        m.doc = { style: 'line', text: `Option of this file. ${option}`, range: fileDoc.range, inherited: true };
        continue;
      }
      m.doc ??= inherited;
    }
  }

  private computeBrackets(): BracketPair[] {
    const pairs: BracketPair[] = [];
    const stack: BracketPair[] = [];
    const closers: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    for (const t of this.sig) {
      if (t.text === '(' || t.text === '[' || t.text === '{') {
        const p: BracketPair = { open: t.start, char: t.text };
        pairs.push(p);
        stack.push(p);
      } else if (closers[t.text]) {
        // Pop to the nearest matching opener (tolerates stray closers).
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].char === closers[t.text]) {
            stack[i].close = t.start;
            stack.length = i;
            break;
          }
        }
      }
    }
    return pairs;
  }

  private computeFolding(scan: ReturnType<typeof scanDirectives>, brackets: BracketPair[]): FoldRegion[] {
    const regions: FoldRegion[] = [];
    const lineOf = (o: number) => this.lines.lineAt(o);
    for (const b of brackets) {
      if (b.close === undefined) continue;
      const s = lineOf(b.open);
      const e = lineOf(b.close);
      if (e > s) regions.push({ startLine: s, endLine: e, kind: 'code' });
    }
    // Comments: multi-line block comments and runs of own-line // comments.
    const toks = this.tokens;
    const regionStack: number[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind === 'blockComment' && t.endLine > t.line) regions.push({ startLine: t.line, endLine: t.endLine, kind: 'comment' });
      if (t.kind === 'lineComment') {
        if (/^\/\/\s*#?region\b/.test(t.text)) {
          regionStack.push(t.line);
          continue;
        }
        if (/^\/\/\s*#?endregion\b/.test(t.text)) {
          const s = regionStack.pop();
          if (s !== undefined) regions.push({ startLine: s, endLine: t.line, kind: 'region' });
          continue;
        }
        const ownLine = (k: number) => toks[k].kind === 'lineComment' && !(k > 0 && toks[k - 1].endLine === toks[k].line);
        if (!ownLine(i)) continue;
        let j = i;
        while (j + 1 < toks.length && ownLine(j + 1) && toks[j + 1].line === toks[j].line + 1) j++;
        if (j > i) regions.push({ startLine: t.line, endLine: toks[j].line, kind: 'comment' });
        i = j;
      }
    }
    // Conditional branches.
    for (const c of scan.conditionals) {
      for (let k = 0; k + 1 < c.branches.length; k++) {
        const s = c.branches[k].range.start.line;
        const e = c.branches[k + 1].range.start.line;
        if (e > s) regions.push({ startLine: s, endLine: e, kind: 'code' });
      }
    }
    // Include groups.
    const inc = scan.includes;
    for (let i = 0; i < inc.length; ) {
      let j = i;
      while (j + 1 < inc.length && inc[j + 1].range.start.line <= inc[j].range.start.line + 2) j++;
      if (j > i) regions.push({ startLine: inc[i].range.start.line, endLine: inc[j].range.start.line, kind: 'imports' });
      i = j + 1;
    }
    return regions.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  }
}
