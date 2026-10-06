// Dev harness for the Values webview (not shipped). Mocks acquireVsCodeApi,
// applies fake VS Code theme variables and feeds sample StateMessages.
// URL params: ?theme=dark|light|hc&scene=paletteNoC|color|float|vec2|vector|vec4|palette|multi|stale|empty|noEditor|hdr|locked|childColor|cursorFloat|many|crossfile|longlabel
(function () {
  const params = new URLSearchParams(location.search);
  const themeName = params.get('theme') || 'dark';
  const scene = params.get('scene') || 'color';

  const font = '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "Ubuntu", "Droid Sans", sans-serif';
  const mono = 'Consolas, "Courier New", monospace';
  const themes = {
    dark: {
      cls: 'vscode-dark',
      vars: {
        'font-family': font,
        'font-size': '13px',
        'editor-font-family': mono,
        foreground: '#cccccc',
        descriptionForeground: '#9d9d9d',
        'sideBar-background': '#181818',
        'editor-background': '#1f1f1f',
        'list-hoverBackground': '#2a2d2e',
        'list-activeSelectionBackground': '#04395e',
        'list-activeSelectionForeground': '#ffffff',
        'list-inactiveSelectionBackground': '#37373d',
        'list-focusOutline': '#0078d4',
        focusBorder: '#0078d4',
        'textLink-foreground': '#4daafc',
        'textLink-activeForeground': '#4daafc',
        'widget-border': '#313131',
        'editorWarning-foreground': '#cca700',
        'list-warningForeground': '#cca700',
        errorForeground: '#f85149',
        'icon-foreground': '#cccccc',
        'toolbar-hoverBackground': 'rgba(90, 93, 94, 0.31)',
        'input-background': '#313131',
        'input-foreground': '#cccccc',
        'input-border': '#3c3c3c',
        'sideBarSectionHeader-background': '#181818',
        'sideBarSectionHeader-foreground': '#cccccc',
        'sideBarSectionHeader-border': '#2b2b2b',
        'editorIndentGuide-background1': '#404040',
        'tree-indentGuidesStroke': '#585858',
        'charts-red': '#f14c4c',
        'charts-green': '#89d185',
        'charts-blue': '#3794ff',
        'charts-yellow': '#cca700',
        'widget-shadow': 'rgba(0, 0, 0, 0.36)',
        'scrollbar-shadow': '#000000',
        'button-background': '#0078d4',
        'button-foreground': '#ffffff',
        'button-hoverBackground': '#026ec1',
        'button-border': 'rgba(255, 255, 255, 0.07)',
        'button-secondaryBackground': '#313131',
        'button-secondaryForeground': '#cccccc',
        'button-secondaryHoverBackground': '#3c3c3c',
        'inputOption-activeBackground': 'rgba(36, 137, 219, 0.51)',
        'inputOption-activeBorder': '#2488db',
        'inputOption-activeForeground': '#ffffff',
        'badge-background': '#616161',
        'badge-foreground': '#f8f8f8',
        'checkbox-background': '#313131',
        'checkbox-border': '#3c3c3c',
        'checkbox-foreground': '#cccccc',
        'menu-background': '#1f1f1f',
        'menu-foreground': '#cccccc',
        'menu-selectionBackground': '#0078d4',
        'menu-selectionForeground': '#ffffff',
        'menu-border': '#454545',
        'keybindingLabel-background': 'rgba(128, 128, 128, 0.17)',
        'keybindingLabel-foreground': '#cccccc',
        'keybindingLabel-border': 'rgba(51, 51, 51, 0.6)',
        'keybindingLabel-bottomBorder': 'rgba(68, 68, 68, 0.6)',
        'scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
        'editorHoverWidget-background': '#202020',
        'editorHoverWidget-border': '#454545',
      },
    },
    light: {
      cls: 'vscode-light',
      vars: {
        'font-family': font,
        'font-size': '13px',
        'editor-font-family': mono,
        foreground: '#3b3b3b',
        descriptionForeground: '#3b3b3b',
        'sideBar-background': '#f8f8f8',
        'editor-background': '#ffffff',
        'list-hoverBackground': '#f2f2f2',
        'list-activeSelectionBackground': '#e8e8e8',
        'list-activeSelectionForeground': '#000000',
        'list-inactiveSelectionBackground': '#e4e6f1',
        focusBorder: '#005fb8',
        'textLink-foreground': '#005fb8',
        'widget-border': '#e5e5e5',
        'editorWarning-foreground': '#bf8803',
        'list-warningForeground': '#855f00',
        errorForeground: '#f85149',
        'icon-foreground': '#3b3b3b',
        'toolbar-hoverBackground': 'rgba(184, 184, 184, 0.31)',
        'input-background': '#ffffff',
        'input-foreground': '#3b3b3b',
        'input-border': '#cecece',
        'sideBarSectionHeader-background': '#f8f8f8',
        'sideBarSectionHeader-foreground': '#3b3b3b',
        'sideBarSectionHeader-border': '#e5e5e5',
        'editorIndentGuide-background1': '#d3d3d3',
        'tree-indentGuidesStroke': '#a9a9a9',
        'charts-red': '#e51400',
        'charts-green': '#388a34',
        'charts-blue': '#1a85ff',
        'charts-yellow': '#bf8803',
        'widget-shadow': 'rgba(0, 0, 0, 0.16)',
        'scrollbar-shadow': '#dddddd',
        'button-background': '#005fb8',
        'button-foreground': '#ffffff',
        'button-hoverBackground': '#0258a8',
        'button-border': 'rgba(0, 0, 0, 0.1)',
        'button-secondaryBackground': '#e5e5e5',
        'button-secondaryForeground': '#3b3b3b',
        'button-secondaryHoverBackground': '#cccccc',
        'inputOption-activeBackground': '#bed6ed',
        'inputOption-activeBorder': '#005fb8',
        'inputOption-activeForeground': '#000000',
        'badge-background': '#cccccc',
        'badge-foreground': '#3b3b3b',
        'checkbox-background': '#f8f8f8',
        'checkbox-border': '#cecece',
        'checkbox-foreground': '#3b3b3b',
        'menu-background': '#ffffff',
        'menu-foreground': '#3b3b3b',
        'menu-selectionBackground': '#005fb8',
        'menu-selectionForeground': '#ffffff',
        'menu-border': '#cecece',
        'keybindingLabel-background': 'rgba(221, 221, 221, 0.4)',
        'keybindingLabel-foreground': '#3b3b3b',
        'keybindingLabel-border': 'rgba(204, 204, 204, 0.4)',
        'keybindingLabel-bottomBorder': 'rgba(187, 187, 187, 0.4)',
        'scrollbarSlider-background': 'rgba(100, 100, 100, 0.4)',
        'editorHoverWidget-background': '#f8f8f8',
        'editorHoverWidget-border': '#c8c8c8',
      },
    },
    hc: {
      cls: 'vscode-high-contrast',
      vars: {
        'font-family': font,
        'font-size': '13px',
        'editor-font-family': mono,
        foreground: '#ffffff',
        descriptionForeground: 'rgba(255, 255, 255, 0.7)',
        'sideBar-background': '#000000',
        'editor-background': '#000000',
        focusBorder: '#f38518',
        contrastBorder: '#6fc3df',
        contrastActiveBorder: '#f38518',
        'textLink-foreground': '#21a6ff',
        'editorWarning-foreground': '#ffd370',
        'list-warningForeground': '#ffd370',
        errorForeground: '#f48771',
        'icon-foreground': '#ffffff',
        'input-background': '#000000',
        'input-foreground': '#ffffff',
        'input-border': '#6fc3df',
        'sideBarSectionHeader-border': '#6fc3df',
        'sideBarSectionHeader-foreground': '#ffffff',
        'editorIndentGuide-background1': '#ffffff',
        'charts-red': '#f14c4c',
        'charts-green': '#89d185',
        'charts-blue': '#3794ff',
        'charts-yellow': '#ffd370',
        'button-background': '#000000',
        'button-foreground': '#ffffff',
        'button-border': '#6fc3df',
        'button-secondaryForeground': '#ffffff',
        'inputOption-activeBorder': '#6fc3df',
        'inputOption-activeBackground': 'rgba(0,0,0,0)',
        'badge-background': '#000000',
        'badge-foreground': '#ffffff',
        'checkbox-background': '#000000',
        'checkbox-border': '#6fc3df',
        'menu-background': '#000000',
        'menu-border': '#6fc3df',
        'list-focusOutline': '#f38518',
      },
    },
  };
  const th = themes[themeName] || themes.dark;
  const root = document.documentElement;
  // Headless browsers enforce a minimum window width: emulate the sidebar width on <html>.
  if (params.get('w')) {
    root.style.width = params.get('w') + 'px';
    root.style.overflow = 'hidden';
  }
  if (params.get('h')) root.style.height = params.get('h') + 'px';
  for (const [k, v] of Object.entries(th.vars)) root.style.setProperty(`--vscode-${k}`, v);
  document.addEventListener('DOMContentLoaded', () => document.body.classList.add(th.cls));
  if (document.body) document.body.classList.add(th.cls);

  // ------------------------------------------------------------------ fixtures
  const R = (l, c, l2, c2) => ({ start: { line: l, character: c }, end: { line: l2 ?? l, character: c2 ?? c + 4 } });
  let n = 0;
  const comp = (value, text, editable = true, integer = false) => ({ range: R(1, n++), value, text: text ?? String(value), editable, integer });
  const anchor = (uri, kind) => ({ uri, kind, fingerprint: '', line: 0, character: 0, ordinal: 0 });
  const target = (kind, name, comps, extra = {}) => {
    const id = `${kind}:${n}:${n++}`;
    const uri = extra.uri || 'file:///noise.glsl';
    return {
      id,
      kind,
      uri,
      version: 1,
      name,
      declKind: extra.declKind || 'local',
      snippet: extra.snippet || `${name}`,
      anchor: anchor(uri, kind),
      range: R(1, 0, 1, 20),
      components: comps,
      colorish: !!extra.colorish,
      ...extra,
    };
  };
  const vec = (kind, name, vals, extra = {}) =>
    target(kind, name, vals.map((v) => comp(v, v.toFixed(2).replace(/0$/, ''))), { ctor: kind, ...extra });

  const palChildren = [
    vec('vec3', 'a', [0.5, 0.5, 0.5], { colorish: true }),
    vec('vec3', 'b', [0.5, 0.5, 0.5], { colorish: true }),
    vec('vec3', 'c', [1.0, 1.0, 1.0]),
    vec('vec3', 'd', [0.0, 0.33, 0.67]),
  ];

  const rows = {
    cursorColor: {
      id: 'cursor',
      kind: 'cursor',
      status: 'ok',
      target: vec('vec3', 'col', [0.9, 0.4, 0.2], { colorish: true, snippet: 'vec3(0.9, 0.4, 0.2)', functionName: 'main' }),
      label: 'col',
      fileName: 'noise.glsl',
      inActiveFile: true,
      line: 42,
      options: {},
    },
    speed: {
      id: 'p_speed',
      kind: 'pin',
      status: 'ok',
      target: target('float', 'u_speed', [comp(1.25, '1.25')], { declKind: 'iUniform', uniform: { declaredType: 'float', min: 0, max: 4 }, snippet: '1.25' }),
      label: 'u_speed',
      fileName: 'noise.glsl',
      inActiveFile: true,
      line: 7,
      options: {},
    },
    light: {
      id: 'p_light',
      kind: 'pin',
      status: 'ok',
      target: vec('vec3', 'lightDir', [0.3, 0.8, 0.52], { snippet: 'vec3(0.3, 0.8, 0.52)' }),
      label: 'lightDir',
      fileName: 'noise.glsl',
      inActiveFile: true,
      line: 18,
      options: {},
    },
    smooth: {
      id: 'p_smooth',
      kind: 'pin',
      status: 'ok',
      target: target('multi', undefined, [], {
        uri: 'file:///main.glsl',
        declKind: 'expression',
        snippet: 'smoothstep(0.1, 0.25, d)',
        children: [target('float', 'edge0', [comp(0.1, '0.1')], { declKind: 'argument' }), target('float', 'edge1', [comp(0.25, '0.25')], { declKind: 'argument' })],
      }),
      label: 'smoothstep(0.1, 0.25, d)',
      fileName: 'main.glsl',
      inActiveFile: false,
      line: 63,
      options: {},
    },
    pal: {
      id: 'p_pal',
      kind: 'pin',
      status: 'ok',
      target: target('palette', 'pal', [], { snippet: 'palette(t, vec3(0.5), …)', children: palChildren, paletteShape: 'call' }),
      label: 'palette(t, …)',
      fileName: 'noise.glsl',
      inActiveFile: true,
      line: 51,
      options: { expanded: false },
    },
    offset: {
      id: 'p_offset',
      kind: 'pin',
      status: 'ok',
      target: vec('vec2', 'offset', [0.25, 0.5], { snippet: 'vec2(0.25, 0.5)' }),
      label: 'offset',
      fileName: 'noise.glsl',
      inActiveFile: true,
      line: 12,
      options: {},
    },
    tint: {
      id: 'p_tint',
      kind: 'pin',
      status: 'ok',
      target: vec('vec4', 'tint', [0.2, 0.6, 1.0, 0.75], { colorish: true, snippet: 'vec4(0.2, 0.6, 1.0, 0.75)' }),
      label: 'tint',
      fileName: 'post.glsl',
      inActiveFile: false,
      line: 9,
      options: {},
    },
    stale: {
      id: 'p_stale',
      kind: 'pin',
      status: 'stale',
      label: 'fogCol',
      fileName: 'util.glsl',
      inActiveFile: false,
      line: 30,
      options: {},
    },
  };

  const cursorFor = {
    hdr: {
      ...rows.cursorColor,
      target: vec('vec3', 'glow', [2.4, 1.2, 0.3], { colorish: true, snippet: 'vec3(2.4, 1.2, 0.3)' }),
      label: 'glow',
    },
    locked: {
      ...rows.cursorColor,
      target: target('vec3', 'p', [comp(NaN, 't', false), comp(0.5, '0.5'), comp(1.0, '1.0')], { ctor: 'vec3', snippet: 'vec3(t, 0.5, 1.0)' }),
      label: 'p',
    },
    cursorFloat: { ...rows.cursorColor, target: target('float', 'k', [comp(0.035, '0.035')], { snippet: 'float k = 0.035;' }), label: 'k' },
    empty: { id: 'cursor', kind: 'cursor', status: 'empty', label: '', inActiveFile: true, options: {}, fileName: 'noise.glsl' },
    noEditor: { id: 'cursor', kind: 'cursor', status: 'noEditor', label: '', inActiveFile: false, options: {} },
  };

  let pins = [rows.speed, rows.light, rows.smooth, rows.pal, rows.offset, rows.tint, rows.stale];
  // many: 19 pins incl. a very long uniform name from another file; longlabel: long label + long file name
  if (scene === 'many') {
    const extra = [];
    for (let i = 0; i < 12; i++) {
      const b = [rows.speed, rows.light, rows.offset, rows.tint][i % 4];
      extra.push({ ...JSON.parse(JSON.stringify(b)), id: 'x' + i, label: i === 3 ? 'u_extremelyLongUniformNameForTestingTruncation_' + i : b.label + i });
    }
    pins = pins.concat(extra);
  }
  if (scene === 'longlabel') {
    rows.smooth.label = 'mix(vec3(0.1, 0.2, 0.3), vec3(0.9, 0.8, 0.7), smoothstep(0.0, 1.0, t))';
    rows.smooth.fileName = 'very_long_shader_file_name_common.glsl';
  }
  let state = {
    type: 'state',
    rows: [cursorFor[scene] || rows.cursorColor, ...(scene === 'noEditor' ? [] : pins)],
    selection: { rowId: 'cursor' },
    settings: { throttleMs: 33, maxDecimals: 4 },
    activeFileName: scene === 'noEditor' ? undefined : 'noise.glsl',
  };
  const selectFor = {
    float: { rowId: 'p_speed' },
    vec2: { rowId: 'p_offset' },
    vector: { rowId: 'p_light' },
    vec4: { rowId: 'p_tint' },
    palette: { rowId: 'p_pal' },
    multi: { rowId: 'p_smooth' },
    stale: { rowId: 'p_stale' },
    childColor: { rowId: 'p_pal', childIndex: 0 },
    many: { rowId: 'x5' },
    crossfile: { rowId: 'p_tint' },
    longlabel: { rowId: 'p_smooth' },
  };
  if (selectFor[scene]) state.selection = selectFor[scene];
  if (scene === 'palette' || scene === 'childColor' || scene === 'paletteNoC') rows.pal.options = {};
  // paletteNoC: `a + b * cos(6.28318 * (t + d))`: c is implicit (read-only 1.0)
  if (scene === 'paletteNoC') {
    const c = palChildren[2];
    c.implicit = true;
    c.splat = true;
    c.components = [comp(1, '1.0', false)];
    rows.pal.target.paletteShape = 'expression';
    rows.pal.label = 'vec3(0.5) + vec3(0.5) * cos(…)';
    state.selection = { rowId: 'p_pal' };
  }

  // ------------------------------------------------------------------ mock extension
  const gestures = new Map();
  const targetOf = (ref) => {
    const row = state.rows.find((r) => r.id === ref.rowId);
    if (!row || !row.target) return undefined;
    return ref.childIndex === undefined ? row.target : row.target.children[ref.childIndex];
  };
  const apply = (ref, values) => {
    const t = targetOf(ref);
    if (!t) return;
    if (t.children && t.components.length === 0) {
      let i = 0;
      for (const c of t.children) for (const comp of c.components) {
        if (values[i] != null) comp.value = values[i];
        i++;
      }
    } else t.components.forEach((c, i) => values[i] != null && c.editable && (c.value = values[i]));
  };
  const send = () => setTimeout(() => window.postMessage(JSON.parse(JSON.stringify(state)), '*'), 0);
  let saved;
  window.acquireVsCodeApi = () => ({
    postMessage(m) {
      if (params.has('log')) console.log('[webview->ext]', JSON.stringify(m));
      (window.__log = window.__log || []).push(m);
      switch (m.type) {
        case 'ready':
          send();
          break;
        case 'select':
          state.selection = m.ref;
          send();
          break;
        case 'setRowOptions': {
          const row = state.rows.find((r) => r.id === m.rowId);
          if (row) row.options = { ...row.options, ...m.options };
          send();
          break;
        }
        case 'editBegin':
          gestures.set(m.gestureId, m.ref);
          break;
        case 'editUpdate':
          apply(gestures.get(m.gestureId), m.values);
          send();
          break;
        case 'editOnce':
          apply(m.ref, m.values);
          send();
          break;
        case 'unpin':
          state.rows = state.rows.filter((r) => r.id !== m.pinId);
          if (state.selection.rowId === m.pinId) state.selection = { rowId: 'cursor' };
          send();
          break;
        case 'pin':
          window.postMessage({ type: 'notice', text: 'Pinned ' + (targetOf(m.ref)?.name ?? 'value'), severity: 'info' }, '*');
          break;
      }
    },
    getState: () => saved,
    setState: (s) => (saved = s),
  });

  // ?click=<css selector>: click an element once the widget is up (e.g. open the presets menu).
  if (params.get('click')) {
    window.addEventListener('load', async () => {
      for (let i = 0; i < 100 && !document.querySelector(params.get('click')); i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200));
      document.querySelector(params.get('click'))?.click();
    });
  }
  // Headless screenshots occasionally miss text painted in the very first frames: force one late repaint.
  window.addEventListener('load', () => setTimeout(() => document.body.classList.add('harness-settled'), 1200));
  // ?debug=<css selector>: overlay outerHTML + computed color of an element.
  if (params.get('debug')) {
    window.addEventListener('load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const el = document.querySelector(params.get('debug'));
      const pre = document.createElement('pre');
      const cs = el && getComputedStyle(el);
      pre.textContent = el ? `${el.outerHTML}
color=${cs.color} bg=${cs.backgroundColor} vis=${cs.visibility} op=${cs.opacity} w=${el.getBoundingClientRect().width}` : 'not found';
      Object.assign(pre.style, { position: 'fixed', left: '0', right: '0', bottom: '0', margin: '0', padding: '6px', background: '#ff0', color: '#000', font: '10px monospace', whiteSpace: 'pre-wrap', zIndex: 99 });
      document.body.append(pre);
    });
  }
  // ?mode=vector: force vector mode on the selected row.
  if (params.get('mode')) {
    const row = state.rows.find((r) => r.id === state.selection.rowId);
    if (row) row.options = { ...row.options, mode: params.get('mode') };
  }

  // ------------------------------------------------------------------ scripted interaction check (?selftest=1)
  if (params.has('selftest')) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const pe = (el, type, x, y, extra = {}) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra }));
    const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    const summary = (m) => {
      const v = m.values ? ' ' + JSON.stringify(m.values) + ' d' + m.decimals : '';
      const r = m.ref ? ' ' + JSON.stringify(m.ref) : '';
      return m.type + (m.gestureId ? '#' + m.gestureId : '') + r + v + (m.commit !== undefined ? ' commit=' + m.commit : '');
    };
    window.addEventListener('load', async () => {
      for (let i = 0; i < 100 && !document.querySelector('.widget-pane:not(.leaving) .slider, .widget-pane:not(.leaving) canvas'); i++) await wait(50);
      await wait(200);
      const out = [];
      const mark = (label) => { out.push('— ' + label); window.__log = []; };
      const flush = () => { for (const m of window.__log || []) out.push(summary(m)); };
      // 1. slider drag
      mark('slider drag 25% -> 75%');
      let slider = document.querySelector('.w-float .slider');
      if (slider) {
        const r = slider.querySelector('.slider-track').getBoundingClientRect();
        const y = r.top + 2;
        pe(slider, 'pointerdown', r.left + r.width * 0.25, y);
        for (let i = 1; i <= 5; i++) { pe(slider, 'pointermove', r.left + r.width * (0.25 + i * 0.1), y, { button: -1 }); await wait(40); }
        pe(slider, 'pointerup', r.left + r.width * 0.75, y);
        await wait(100);
        flush();
        // 2. keyboard repeat = one gesture
        mark('3x ArrowRight (one gesture)');
        slider.focus();
        for (let i = 0; i < 3; i++) { key(slider, 'ArrowRight'); await wait(60); }
        await wait(800);
        flush();
        // 3. typed value
        mark('type 2.5 + Enter in value field');
        const inp = document.querySelector('.w-float .float-main .num-input');
        inp.focus(); inp.value = '2.5'; key(inp, 'Enter');
        await wait(100);
        flush();
        inp.blur();
      }
      // 4. list scrub on the first pinned number
      mark('scrub list number +12px');
      const num = document.querySelector('#row-p_speed .num');
      if (num) {
        const r = num.getBoundingClientRect();
        pe(num, 'pointerdown', r.left + 2, r.top + 4);
        // a real pointermove reports button -1 (no button change) with buttons 1
        for (let i = 1; i <= 6; i++) { pe(num, 'pointermove', r.left + 2 + i * 2, r.top + 4, { movementX: 2, button: -1 }); await wait(40); }
        pe(num, 'pointerup', r.left + 14, r.top + 4);
        await wait(100);
        flush();
      }
      // 5. select another row via keyboard
      mark('list ArrowDown');
      const lb = document.querySelector('.listbox');
      lb.focus(); key(lb, 'ArrowDown');
      await wait(100);
      flush();
      const pre = document.createElement('pre');
      pre.id = 'selftest';
      pre.textContent = out.join('\n');
      Object.assign(pre.style, { position: 'fixed', inset: '0', margin: '0', padding: '8px', background: '#000', color: '#0f0', font: '11px monospace', whiteSpace: 'pre-wrap', zIndex: 99 });
      document.body.append(pre);
    });
  }
})();
