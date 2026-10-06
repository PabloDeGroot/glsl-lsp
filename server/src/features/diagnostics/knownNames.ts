// Names the undeclared-identifier check never reports although the builtins
// registry (ctx.workspace.builtins, the primary source) does not list them:
// the `main` entry point and the extra iChannel4-7 samplers some Shadertoy
// ports declare implicitly. Add a name here only when it is not a real
// builtin; real builtins belong in server/src/builtins.

export const KNOWN_NAMES: ReadonlySet<string> = new Set(['main', 'iChannel4', 'iChannel5', 'iChannel6', 'iChannel7', 'true', 'false']);

/** Prefixes that denote implementation-provided names. */
export function hasKnownPrefix(name: string): boolean {
  return name.startsWith('gl_') || name.startsWith('__') || /^Key_[A-Za-z0-9]+$/.test(name);
}
