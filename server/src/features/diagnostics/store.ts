// Diagnostics come from several independent producers (fast checks per file,
// one glslang run per root file). The store keeps each producer's latest
// result in its own layer and merges them when publishing, so a slow
// glslang run never wipes fresh fast results and vice versa.

import type { Diagnostic } from 'vscode-languageserver/node';

const UNDECLARED_RE = /undeclared identifier|no matching overloaded function found/i;

export class DiagnosticStore {
  private readonly fast = new Map<string, Diagnostic[]>();
  /** root uri -> (uri -> diagnostics) of the latest glslang run of that root. */
  private readonly glslang = new Map<string, Map<string, Diagnostic[]>>();

  /** Replaces the fast layer of `uri`. Returns the uris whose merged output changed. */
  setFast(uri: string, diagnostics: Diagnostic[]): string[] {
    this.fast.set(uri, diagnostics);
    return [uri];
  }

  /** Replaces the glslang layer of `root`. Returns every uri touched by the old or new result. */
  setGlslang(root: string, byUri: Map<string, Diagnostic[]>): string[] {
    const affected = new Set<string>([...(this.glslang.get(root)?.keys() ?? []), ...byUri.keys(), root]);
    this.glslang.set(root, byUri);
    return [...affected];
  }

  clearGlslang(root: string): string[] {
    const old = this.glslang.get(root);
    if (!old) return [];
    this.glslang.delete(root);
    return [...old.keys()];
  }

  /** Forgets everything about a closed document. Returns the uris to republish. */
  clearDocument(uri: string): string[] {
    this.fast.delete(uri);
    return [uri, ...this.clearGlslang(uri)];
  }

  /** True when the fast layer of `uri` reports an undeclared identifier. */
  hasUndeclared(uri: string): boolean {
    return (this.fast.get(uri) ?? []).some((d) => d.code === 'undeclared-identifier');
  }

  hasGlslang(root: string): boolean {
    return this.glslang.has(root);
  }

  merged(uri: string): Diagnostic[] {
    const fast = this.fast.get(uri) ?? [];
    const external: Diagnostic[] = [];
    for (const layer of this.glslang.values()) external.push(...(layer.get(uri) ?? []));

    const undeclaredKey = (d: Diagnostic) => `${d.range.start.line}|${(d.data as { name?: string } | undefined)?.name}`;
    const fastUndeclared = new Set(fast.filter((d) => d.code === 'undeclared-identifier').map(undeclaredKey));
    const glslangErrorLines = new Set(external.filter((d) => d.severity === 1 && d.code === 'glslang').map((d) => d.range.start.line));

    // glslang's report of the same undeclared name collapses into the fast one (which carries
    // the "Add #include" quick-fix data), taking glslang's severity: it is authoritative.
    const collided = new Map<string, number>();
    const keptExternal = external.filter((d) => {
      if (d.code !== 'glslang' || !UNDECLARED_RE.test(d.message)) return true;
      const name = /\('([^']+)'\)\s*$/.exec(d.message)?.[1];
      const key = `${d.range.start.line}|${name}`;
      if (!name || !fastUndeclared.has(key)) return true;
      const sev = d.severity ?? 1;
      collided.set(key, Math.min(collided.get(key) ?? sev, sev));
      return false;
    });
    // glslang is authoritative for syntax: drop the parser's own report for the same line.
    const keptFast = fast
      .filter((d) => d.code !== 'syntax' || !glslangErrorLines.has(d.range.start.line))
      .map((d) => {
        if (d.code !== 'undeclared-identifier') return d;
        const sev = collided.get(undeclaredKey(d));
        return sev !== undefined && sev < (d.severity ?? 1) ? { ...d, severity: sev as Diagnostic['severity'] } : d;
      });

    // Identical diagnostics from different roots show once.
    const seen = new Set<string>();
    const out: Diagnostic[] = [];
    for (const d of [...keptFast, ...keptExternal]) {
      const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}|${d.severity}|${d.code}|${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }
}
