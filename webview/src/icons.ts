// Inline 16x16 codicon-like icons (currentColor, 1.2px strokes). Static
// markup only: injected with innerHTML, no style attributes (CSP-safe).

const svg = (body: string, extra = ''): string =>
  `<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

export const icons = {
  pin: svg('<g transform="rotate(45 8 8)"><path d="M5.5 2.5h5"/><path d="M6.5 2.5v4L4.5 9h7L9.5 6.5v-4"/><path d="M8 9v4.5"/></g>'),
  pinned: svg('<path d="M5.5 2.5h5"/><path d="M6.5 2.5v4L4.5 9h7L9.5 6.5v-4z" fill="currentColor"/><path d="M8 9v4.5"/>'),
  close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  warning: svg('<path d="M8 2.2l6.2 11.1H1.8z"/><path d="M8 6.4v3.2"/><circle cx="8" cy="11.4" r=".55" fill="currentColor" stroke="none"/>'),
  goto: svg('<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L8 8"/><path d="M11.5 9.5v4h-9v-9h4"/>'),
  chevron: svg('<path d="M6 4l4 4-4 4"/>'),
  back: svg('<path d="M13 8H3.5"/><path d="M7 4.5L3.5 8 7 11.5"/>'),
  color: svg('<path d="M8 2.2S4 6.6 4 9.6a4 4 0 008 0C12 6.6 8 2.2 8 2.2z"/>'),
  vector: svg('<path d="M3 13l9.5-9.5"/><path d="M7 3.5h5.5V9"/>'),
  reset: svg('<path d="M3.5 5.5h6a3.5 3.5 0 010 7H6"/><path d="M6 3L3.5 5.5 6 8"/>'),
  preset: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>'),
  lock: svg('<path d="M5.5 7V5.2a2.5 2.5 0 015 0V7"/><rect x="3.8" y="7" width="8.4" height="6.5" rx="1"/>'),
  target: svg('<circle cx="8" cy="8" r="5.3"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/>'),
  file: svg('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/><path d="M6 8.5h4M6 11h4"/>'),
  normalize: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 8l3.9-3.9"/><circle cx="8" cy="8" r=".8" fill="currentColor" stroke="none"/>'),
  hash: svg('<path d="M6 2.5L5 13.5M11 2.5l-1 11M2.8 6h11M2.2 10.2h11"/>'),
};

export type IconName = keyof typeof icons;

/** A span holding an icon. */
export function iconEl(name: IconName, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `codicon ${cls}`.trim();
  s.innerHTML = icons[name];
  return s;
}
