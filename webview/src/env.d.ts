// Ambient declarations for the webview bundle (esbuild loaders, VS Code webview API).

/** `import icon from './icons/pin.svg'` -> SVG markup string (esbuild 'text' loader). */
declare module '*.svg' {
  const markup: string;
  export default markup;
}

/** Injected by VS Code into every webview. Call once; keep the result. */
declare function acquireVsCodeApi<State = unknown>(): {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
};
