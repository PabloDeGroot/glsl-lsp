// User settings (the `glslLsp.*` configuration section) with defaults and a
// change event. Mirrors `contributes.configuration` in package.json: keep the
// two in sync when adding a setting.

export interface Settings {
  includePaths: string[];
  diagnostics: {
    /** Master switch for all diagnostics. */
    enable: boolean;
    /** Report identifiers that resolve to nothing. */
    undeclared: boolean;
    glslang: { enable: boolean; path: string };
    onType: boolean;
  };
  completion: { autoInclude: boolean };
  rename: { readOnlyPaths: string[] };
  inlayHints: { parameterNames: ParameterNamesMode };
  colors: { mode: ColorMode };
  shadertoy: { enable: boolean };
  index: { exclude: string[]; maxFiles: number };
  /** Values panel. Read by the extension client only; mirrored here so package.json and the defaults stay in sync. */
  values: { throttleMs: number; maxDecimals: number; followCursor: boolean };
  trace: { server: 'off' | 'messages' | 'verbose' };
}

export type ParameterNamesMode = 'none' | 'literals' | 'all';
export type ColorMode = 'heuristic' | 'all' | 'off';

export const defaultSettings: Settings = {
  includePaths: [],
  diagnostics: { enable: true, undeclared: true, glslang: { enable: true, path: 'glslangValidator' }, onType: true },
  completion: { autoInclude: true },
  rename: { readOnlyPaths: ['lygia'] },
  inlayHints: { parameterNames: 'literals' },
  colors: { mode: 'heuristic' },
  shadertoy: { enable: true },
  index: { exclude: ['node_modules', '.git', 'out', 'dist', '.vscode-test'], maxFiles: 10000 },
  values: { throttleMs: 33, maxDecimals: 4, followCursor: true },
  trace: { server: 'off' },
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merges `value` over `defaults`, ignoring values of the wrong type. */
export function mergeSettings<T>(defaults: T, value: unknown): T {
  if (!isObject(defaults) || !isObject(value)) {
    if (value === undefined || value === null) return defaults;
    if (Array.isArray(defaults)) return (Array.isArray(value) ? value : defaults) as T;
    return (typeof value === typeof defaults ? value : defaults) as T;
  }
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) out[key] = mergeSettings((defaults as Record<string, unknown>)[key], value[key]);
  return out as T;
}

/** Maps legacy / out-of-range values onto the enums (e.g. `parameterNames: true` -> 'literals'). */
function normalize(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (isObject(raw.inlayHints)) {
    const v = raw.inlayHints.parameterNames;
    const mode = v === true ? 'literals' : v === false ? 'none' : v;
    out.inlayHints = { ...raw.inlayHints, parameterNames: ['none', 'literals', 'all'].includes(mode as string) ? mode : undefined };
  }
  if (isObject(raw.colors)) {
    const m = raw.colors.mode;
    out.colors = { ...raw.colors, mode: ['heuristic', 'all', 'off'].includes(m as string) ? m : undefined };
  }
  return out;
}

export class SettingsStore {
  private current: Settings = defaultSettings;
  private readonly listeners = new Set<(s: Settings, previous: Settings) => void>();

  get(): Settings {
    return this.current;
  }

  /** Replace settings from a raw `glslLsp` configuration object. */
  update(raw: unknown) {
    const previous = this.current;
    this.current = mergeSettings(defaultSettings, normalize(raw));
    for (const l of this.listeners) l(this.current, previous);
  }

  onDidChange(listener: (s: Settings, previous: Settings) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}
