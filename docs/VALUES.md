# Values panel — specification

A side panel that turns the numbers in a GLSL file into live widgets
(slider, 2D trackpad, color picker, direction trackball, cosine-palette
editor), inspired by [glslEditor](https://github.com/patriciogonzalezvivo/glslEditor)'s
pickers. Dragging a widget rewrites the literal in the document live, so the
shader-toy extension's preview updates while you drag.

VS Code cannot host interactive widgets inside the text editor, so the
widgets live in a webview view in the Activity Bar.

Contract files (frozen, read them first):

- `shared/valuesProtocol.ts` — LSP request/response types, pin anchors, row
  view model, every webview <-> extension message.
- `shared/valuesMath.ts` — number formatting, steps, smart ranges, line
  fingerprints (implemented and tested: `test/valuesMath.test.ts`).

---

## 1. Layout

One Activity Bar container **GLSL** (icon `media/values.svg`) with one
webview view **Values** (`glslLsp.values`). The native view title bar
carries two actions: *Pin Value at Cursor* (`$(pin)`) and *Unpin All*
(`$(clear-all)`, only when there are pins).

Inside the webview, top to bottom (mock at ~300 px):

```
┌──────────────────────────────────────────────┐
│ VALUES                          📌  ⌫         │  native view title + actions
├──────────────────────────────────────────────┤
│ ▾ CURSOR                      noise.glsl:42  │  section header (22px, uppercase 11px)
│▌■ col           0.90 0.40 0.20          📌   │  cursor row (always first), selected
│ ▾ PINNED  3                                  │
│  ◔ u_speed               1.250           ×   │  float: mini gauge glyph
│  ↗ lightDir        0.30 0.80 0.52        ×   │  vec3 direction: arrow glyph
│  ▾ # smoothstep(0.1, 0.25, d)  main.glsl ×   │  multi (other file: file badge)
│      edge0               0.10                │    child sub-row (indent 16px)
│      edge1               0.25                │
│  ⚠ fogCol          not found  util.glsl  ×   │  stale pin
├──────────────────────────────────────────────┤  1px divider (sideBarSectionHeader-border)
│ ■ col   [📌 Pinned|← Cursor] [Color|Vector] ↗ │  widget header: name, follow chip (pin selected), mode, go-to
│   vec3 · color · a.glsl:9                    │  meta line, full width (file:line truncates last)
│ ┌──────────────────────────────┐ ┌──┐        │
│ │        S/V square            │ │H │        │  color picker
│ │                       ○      │ │u │        │
│ └──────────────────────────────┘ └──┘        │
│ [old|new]  #E66633   R 0.9   G 0.4   B 0.2   │
│                                    notices   │  footer: transient notices only
└──────────────────────────────────────────────┘
```

- The view is a flex column of the viewport height. The **widget area**
  keeps its natural height and always reserves `--gv-widget-min-height`
  (236 px) so switching rows or kinds never makes the layout jump; canvases
  shrink with short views (`--gv-canvas-max: clamp(160px, 42vh, 280px)`).
  The **list** takes the remaining room and scrolls on its own (shrinking
  down to about three rows first); only when even that does not fit does the
  whole body scroll. The CURSOR section (header + row, when it has at most
  three lines) sits *above* the list's scroll container, so a pin row can
  never be half-hidden under it; inside the scroller the PINNED header (with
  its count) is sticky. A taller cursor section (an expanded multi) moves
  into the scroller. Scroll shadows (`scrollbar.shadow`) mark hidden rows:
  under the fixed cursor section / the stuck PINNED header, and at the
  bottom. The selected row (whatever changed it) and a newly added pin are
  scrolled into view inside the list.
- Section headers are custom (the view has one webview) but must look like
  VS Code pane headers: 22 px, 11 px bold uppercase, chevron, collapsible
  (collapse state in `vscode.setState`). The CURSOR header shows the active
  file name right-aligned, muted.
- Width: designed for 240–320 px, everything fluid; canvases are
  `min(container width - gutters, 280px)` square (the S/V square is 3:2),
  centered when wider.

### Row anatomy (22 px, like a VS Code list row)

```
│▌ [glyph 16] label…………………  [file badge] [value preview]  [actions] │
```

- **Selection bar**: 2 px accent on the left (`--vscode-focusBorder`) plus
  `list.inactiveSelectionBackground` (`activeSelection*` while the list has
  focus).
- **Glyph** (16×16, drawn with CSS/SVG, not text): float = tiny circular gauge
  of the value within its range; vec2 = dot in a square; color = 12 px
  swatch (rounded 2 px, 1 px inner border at 20% fg, checkerboard behind
  alpha); direction = arrow rotated to the vector's xy projection; palette =
  12×12 gradient strip; multi = `#`; stale = warning icon in
  `editorWarning.foreground`.
- **Label**: name, else snippet; ellipsis; tooltip = full snippet +
  `file:line`. Stale: italic, muted.
- **File badge**: base name, muted, small, only when the target is not in the
  active file (`RowState.inActiveFile === false`). It never ellipsizes into a
  fragment: the label truncates first, and once the label is down to a few
  characters (or the name would be cut very short) the badge shows only the
  file icon, full name in the tooltip (`List.fitBadge`).
- **Value preview**: editor monospace 12 px, right-aligned, tabular-nums.
  Every number is shown with its literal's own precision (`1.25`, `0.200`,
  `1.0`; `displayDecimals`, 1..4), the same rule as every widget input, and
  more digits only while a value needs them (a drag at a finer step); it
  never depends on the panel width. Each number is a separate scrub zone;
  palette: gradient strip; multi: count `3 values`; stale `not found` (in
  `list.warningForeground`). `cursor: ew-resize` on numbers — see *Scrubbing*.
- Rows without an action button reserve its column, so all previews end at
  the same x (child rows included).
- **Actions** (16 px icon buttons, visible on hover / focus-within /
  selected, always visible on the cursor row): cursor row = Pin (outline) or
  Pinned (filled, clicking unpins); pin rows = Unpin (×). Tooltips with
  keyboard hints.

### Selection model

- `StateMessage.selection` is a `TargetRef {rowId, childIndex?}` owned by the
  extension. Default: the cursor row.
- Clicking a row (or a sub-row) sends `select`. A selected **pin stays
  selected** while the editor cursor moves; the cursor row keeps updating
  above it.
- Ways back to the cursor: click the cursor row (its tooltip says so while a
  pin is selected), the *← Cursor* button of the **Pinned** chip on the
  widget header's second line (shown only while a pin is selected, always at
  the same place whatever the widget), or `Escape` while no gesture is
  active.
- Pinning does not move the selection: it stays on the cursor row (a pin is
  a bookmark, not a mode switch); the new pin flashes once (160 ms
  background pulse).
- Unpinning the selected pin selects the cursor row.
- Multi/palette: selecting the parent row shows the parent widget (slider
  stack / palette editor); selecting a child sub-row shows that child's own
  widget (float slider, or vec widget).

---

## 2. States

| State | List | Widget area |
| --- | --- | --- |
| No GLSL editor (`status: 'noEditor'`) | Cursor row shows muted "Open a GLSL file" | Empty state: icon + "Open a GLSL file and put the cursor on a number, vec2/vec3/vec4 or color." |
| Cursor on nothing (`'empty'`) | Cursor row muted "No value at cursor" | Empty state: "Put the cursor on a number, a vec2/vec3/vec4 constructor, a color or a uniform." + hint line "Tip: Ctrl+Alt+↑/↓ nudges the number under the cursor." |
| Loading (`'loading'`) | Skeleton shimmer on the preview, label kept | Keeps the previous widget (no flash) |
| Cursor only | Cursor row, PINNED section shows "No pinned values — use 📌 to keep a value here." (one muted line) | Widget for cursor target |
| Pins | As mock | Widget for the selection |
| Stale pin (`'stale'`) | Warning glyph (warning color), italic last label, `not found` warning pill, file badge; tooltip "The pinned value could not be found. Click to go to its last location." Actions: unpin | "This value is no longer in *file*" + buttons *Go to last location* (sends `reveal`) and *Unpin* |
| Multi | Row has a chevron; expanded (default when selected) shows one sub-row per child with its param name (`edge0`) or `#1..n` | Slider stack (one compact slider per child) |
| Palette | Glyph is a gradient strip; expandable to a/b/c/d sub-rows | Palette editor |
| Locked components | Locked numbers shown as their expression text, muted | Component slider fallback (below) |

Empty states use a 24 px muted outline icon, a one-line title and one line
of help; vertically centered in the reserved widget height.

---

## 3. Widgets

All widgets: header line = glyph, **name** (or snippet), muted badges
(`vec3`, `color`, `#iUniform`, `in 0–4`), right side: mode toggle (vec3/vec4
only), *go to source* icon button (`reveal`). Below the canvas, a row of
numeric inputs (one per component, axis-colored 2 px left border: x/r red,
y/g green, z/b blue, w/a yellow, using `--vscode-charts-*`).

Numeric inputs: `--vscode-input-*` colors, 22 px tall, monospace, select-all
on focus, commit on Enter/blur (`editOnce`), Escape reverts, ↑/↓ step (Shift
×10, Alt ×0.1), also scrubbable by dragging their label. An input that has
focus is **never** overwritten by an incoming state.

### float → slider

- Custom slider: 4 px track (input-border / fg 25%), filled part in
  `--vscode-button-background`, 12 px round thumb with 1 px border; focus
  ring = 1 px `focusBorder` outline offset 2 px. Ticks: 5 subtle ticks at
  nice values. Under the track, min and max as small editable mono fields at
  the ends; the value input sits to the right of the track.
- Range: `uniform.min/max` when present (fields read-only, tooltip
  "from #iUniform"); else `RowOptions.range`; else `smartRange(value)`.
  Editing min/max sends `setRowOptions({range})`. Typing a value outside the
  range auto-extends the range (`smartRange`) unless uniform-bound.
- Steps: `dragStep = uniform.step ?? stepForRange(min, max)`; `keyStep =
  uniform.step ?? dragStep * 10`; integer components step 1. `decimals =
  decimalsForStep(dragStep)` (the extension clamps to `maxDecimals`).
- Pointer: press on the track jumps then drags (pointer capture); pressing
  the thumb grabs it without writing anything; Shift while dragging = fine
  (×0.1 relative to the press point). Double-clicking the **thumb** resets
  to the value at selection time (one undo step); a double-click on the
  track is just a jump (the second press never jumps again and no reset
  follows, so there is no flash and no extra undo step). The *Reset to …*
  link under the slider does the same; it is shown only while the value
  differs from the reset value. The reset value is captured per target
  (document + target id) at its first selection or first gesture (list
  scrub / inline edit), not per widget instance, so rebuilding the widget
  (cursor ↔ pin, mode switch) never moves it.
- Range fields: a `#iUniform … in { min, max }` range is read-only (dashed
  fields, lock icon, caption *from #iUniform*); the automatic range (*auto
  range*) and a range the user typed (*custom range*, with a reset button)
  are editable (solid fields). Each field's tooltip says which it is.
- Keyboard: ←/↓ −keyStep, →/↑ +keyStep, Shift ×10, Alt ×0.1, PageUp/PageDown
  ×10, Home/End = min/max. Repeated key presses within 600 ms form one
  gesture (one undo step).

### vec2 → trackpad

- Square canvas: grid (10 divisions, `--gv-grid`), axes through 0 when 0 is
  inside the range (x in `--gv-axis-x`, y in `--gv-axis-y`, 50% alpha), dotted
  guide lines from the point to both axes, point = 6 px ring (fg) with 2 px
  fill (button background), 8 px when hovered/dragged. Y up.
- Same range on both axes (square); default: `smartRange(max(|x|,|y|))`
  made symmetric when any component is negative (so a uv-like `1.0` is not
  on the edge). Editable min/max fields under the canvas (`setRowOptions`).
  Ctrl+wheel zooms the range ×2/÷2 around 0.
- Pointer: pressing the handle (10 px radius) grabs it and drags relative to
  the grab point without writing on press; pressing elsewhere jumps + drags;
  Shift = fine (relative ×0.1); Ctrl = snap to grid. Double-clicking the
  handle resets to the value at selection time. The trackball tip behaves
  the same way.
- Keyboard (canvas focusable, `role="slider"` pair announced via
  `aria-valuetext="x 0.25, y 0.50"`): arrows move by keyStep, Shift ×10, Alt ×0.1.
- Inputs: X, Y.

### vec3 / vec4 → color picker or direction picker

Mode = `RowOptions.mode ?? (target.colorish ? 'color' : 'vector')`. A
segmented control `[Color | Vector]` in the header switches it
(`setRowOptions({mode})`), persisted per pin.

**Color picker**

- S/V square (3:2) + 16 px vertical hue strip on its right; vec4: 12 px
  alpha strip below with checkerboard. Marker: 10 px ring, white with a dark
  1 px outer ring (visible on any color).
- Below: a 28×20 swatch split *old | new* (old = value when the row was
  selected; clicking old reverts with `editOnce`), hex field (`#RRGGBB` /
  `#RRGGBBAA`, accepts 3/4/6/8 digits, with or without `#`), and R G B (A)
  inputs as 0..1 floats.
- HDR: if any component > 1, the picker edits the chroma of
  `color / k` with `k = max component`, and shows an *Intensity* slider (k,
  range `[0, smartRange(k).max]`); written value = chroma × k.
- Keyboard: SV square arrows ±1% S / V (Shift ±10%); hue strip ↑/↓ ±1° (Shift
  ±10°); alpha ←/→ ±1%.
- Decimals written: 3 (`formatFloat`, trimmed: `0.9`, `0.403`).

**Direction picker (trackball)**

- Square canvas with a shaded sphere disc (radial gradient from fg 12% to
  fg 3%), three great circles (equator + two meridians) as thin lines
  rotated by the view, an axis gizmo (X/Y/Z colored, labeled at the tips;
  back-facing tips at 35% alpha), and the vector: line from the center to the
  point on the sphere, point = 7 px dot; when the point is on the back
  hemisphere the line is dashed and the dot hollow.
- Default view: slightly rotated (yaw 25°, pitch 20°) so all three axes are
  readable. Alt-drag (or middle/right drag) orbits the view; double-click on
  the background resets the view. View state is UI-only (`setState`).
- Dragging the point (or anywhere with the primary button) rotates the
  vector like an arcball under the view: the new direction is the sphere
  point under the pointer (pointer outside the disc → on the silhouette,
  hemisphere chosen by continuity). Shift = snap to 15° in yaw/pitch, Ctrl
  = snap to the nearest axis or 45° diagonal.
- Length: readout `|v| = 1.732` under the canvas, a *Keep length* checkbox
  (default on, `RowOptions.keepLength`) and a *Normalize* button (one-shot
  edit to length 1). With keep length off, the trackball writes unit vectors.
  A zero vector shows the point at the center with the hint "Zero vector —
  drag to set a direction" (treated as length 1).
- vec4 in vector mode: trackball for xyz + a slider for w.
- Keyboard: arrows rotate by 5° around the view up/right axes (Shift 15°,
  Alt 1°).
- Inputs: X Y Z (W).

### Locked components fallback

If any component of a vecN is not editable (`editable: false`), the widget
is a **component slider stack** (one float slider per component, locked
ones shown read-only with their expression text). Same for vecN with an
integer component.

### multi → slider stack

One compact row per child: label (param name or `#n`, 72 px, ellipsis),
slider, value input. Children that are vectors show their inline numbers
and a "›" button that selects the child (full widget). Max 8 visible rows,
the stack scrolls beyond.

### palette → palette editor

- A 100% × 28 px gradient strip of `col(t) = a + b·cos(2π(c·t + d))`
  (rounded 4 px, 1 px border). Hover shows a vertical t marker and the color
  at t in a tooltip.
- Below, the cosine curves of r/g/b over t (small 100% × 56 px canvas,
  axis colors) — the classic iq visualization, helps understand c/d.
- Four rows `a` (offset), `b` (amplitude), `c` (frequency), `d` (phase):
  label, three scrub numbers (r g b), one mini-swatch for a/b. Each number
  is scrubbable and editable; per-row ranges: a, b `[0,1]`, c `[0,2]`, d
  `[0,1]` (extend when outside).
- *Presets* menu (iq's classic set) applies all 12 values as one
  `editOnce` without childIndex (values concatenated a,b,c,d).

### Scrubbing (list and inputs)

Pointer down on a number in a row preview (or on an input's label): after
3 px of horizontal motion a gesture starts (`editBegin`); each px adds
`stepForLiteral(component.text)` (Shift ×10, Alt ×0.1); pointer lock is
requested so the drag is unbounded (fallback: capture). Release ends the
gesture; a click without motion just selects the row; double-click opens an
inline input.

---

## 4. Keyboard map

| Where | Keys | Action |
| --- | --- | --- |
| Editor (GLSL) | Ctrl+Alt+↑ / ↓ | Nudge number under cursor by its step (`stepForLiteral`) |
| Editor (GLSL) | Ctrl+Shift+Alt+↑ / ↓ | Nudge ×10 |
| Editor (GLSL) | context menu / palette | *GLSL: Pin Value at Cursor* |
| Anywhere | *GLSL: Focus Values Panel* | Reveal the view and focus the selected widget |
| List | ↑ / ↓, Home / End | Move selection (roving tabindex, `role=listbox`) |
| List | → / ← | Expand / collapse multi & palette rows |
| List | Enter | Reveal in editor (`reveal`) |
| List | P | Pin (cursor row) / unpin (pin row) |
| List | Delete / Backspace | Unpin |
| List | Alt+↑ / ↓ | Move pin up/down (`reorderPins`) |
| Widget | Tab / Shift+Tab | Canvas → inputs → mode toggle, in visual order |
| Widget | arrows (+Shift ×10, Alt ×0.1), PgUp/PgDn, Home/End | See each widget |
| Widget | Escape (during drag) | Cancel gesture (`editEnd {commit:false}`) |
| Widget / list | Escape (idle, pin selected) | Back to cursor |

Note: on Windows `Ctrl+Alt+↑/↓` is *Add Cursor Above/Below* (our binding
is more specific via `editorLangId == glsl`). The nudge commands only edit
when there is a single cursor on a number or *every* cursor is on a number;
otherwise they run the platform's default command for the key
(`nudgeFallback`): Windows → `editor.action.insertCursorAbove/Below` and
`cursorColumnSelectUp/Down`; Linux → column select only (Linux's Add Cursor
is `Shift+Alt+↑/↓`, VS Code binds nothing to `Ctrl+Alt+↑/↓`); macOS →
nothing. So an Add Cursor / column-selection run that passes over a number
never switches into nudging half-way. README mentions it and how to rebind.

Focus visuals: every focusable element gets `outline: 1px solid
var(--vscode-focusBorder); outline-offset: -1px` (rows) / `2px` (thumbs,
canvases); never remove outlines without a replacement. High contrast:
borders use `--vscode-contrastBorder` / `contrastActiveBorder` when defined.

---

## 5. Number formatting (shared/valuesMath.ts)

- Floats: `formatFloat(value, decimals, maxDecimals)` — rounded, trailing
  zeros trimmed, always a `.` and one digit (`2.0`, `0.5`), never `-0.0`.
  `decimals` comes from the widget step (`decimalsForStep`) or the typed
  text; the cap is `glslLsp.values.maxDecimals` (default 4) raised to the
  literal's own decimals (`0.00025` keeps 5). A value too small for the cap
  is written with an exponent (`1e-5`, `2.5e-4`) instead of `0.0`, and a
  literal written with an exponent keeps that style for tiny values.
- `smartRange(v)`: `[0, 1]` for |v| in [0.1, 0.5], else `[0, m]` with `m` the
  smallest 1/2/5×10ⁿ ≥ 2|v| (`1.0` → 2, `0.035` → 0.1, `3` → 10), symmetric
  for negatives: common values never sit at the end of the track.
- A stale gesture target never writes: before an edit the extension
  re-resolves the target when the document version moved on, and every slot
  must still read as the same complete token (`0.5` does not match the start
  of `0.55`).
- Nudge after a binary `-`/`+` keeps a space before a negative result
  (`1.0- -0.5`, never the decrement operator `--`).
- Integer literals (`component.integer`): `formatInt`, step 1.
- Negative values are written with a leading `-` into the component range
  (which already includes a unary minus). After a binary minus the result is
  `x - -0.5` — valid GLSL, accepted.
- Splat `vec3(0.5)` stays a splat while all written components are equal;
  otherwise the whole `range` is replaced by `ctor(a, b, c)` with `, `
  separators. A full constructor is never collapsed into a splat.
- Separators and whitespace of untouched text are preserved (component
  edits replace only component ranges).
- Nudge: `stepForLiteral(text)` = one unit of the last decimal of the
  literal (min 0.1 for floats: `1.0`→0.1, `0.25`→0.01, `2.`→0.1, int `3`→1);
  written with the literal's own decimals (so `0.25`+ → `0.26`, `1.0`+ →
  `1.1`, `0.9`+ → `1.0`).
- UI display: `formatDisplay` (fixed decimals, tabular).

---

## 6. Edits: throttling, undo, no fighting the user

Webview side:

1. `pointerdown` → `editBegin {gestureId, ref}` (ids increase per webview
   instance from a random base, so they never collide with gestures of a
   reloaded instance). Starting any edit ends every open key gesture first.
   The widget updates optimistically at animation-frame rate.
2. `editUpdate {values, decimals}` at most every `settings.throttleMs`
   (default 33 ms) with a trailing send; the latest values are always flushed
   before `editEnd`.
3. `pointerup` → `editEnd {commit:true}`; Escape → `{commit:false}`.
4. While a gesture is active the webview ignores incoming state values for
   that target (other rows still update). On `editRejected` it drops the
   gesture, shows the reason in a transient notice and re-renders from the
   last state.

Extension side (client-controller):

1. **editBegin**: resolve the ref against the current row target; when the
   target's `version` is older than the document (the follow-up query of the
   previous edit has not returned yet), re-resolve it first through its
   anchor (`glslLsp/valueTargets {anchors:[target.anchor]}`). Convert
   component ranges to offsets, verify that every editable component still
   reads as the same complete token (`slotIntact`: same text, no word/number
   character glued on either side; else `editRejected "The value changed"`),
   snapshot the original text of the whole target range.
2. **editUpdate**: coalesce — if an apply is in flight, keep only the latest
   values; apply when the previous one resolved (natural backpressure).
   Build edits only for components whose formatted text changed, right to
   left; after applying, shift the locally tracked offsets by the length
   deltas (the server is not re-queried during a gesture).
3. **Undo — one step per gesture**:
   - Document visible in an editor (`window.visibleTextEditors`, any
     column): `editor.edit(cb, {undoStopBefore: first, undoStopAfter:
     false})` for every update. At `editEnd`: restore the snapshot
     (`{false,false}`) then apply the final text (`{false, true}`), so the
     whole gesture is a single undo element even when the final text equals
     the last update. `commit:false` = restore only, with `{false, true}`.
   - Not visible (pin from another file): open it with
     `workspace.openTextDocument` (no editor) and use `WorkspaceEdit`. VS
     Code gives no undo-stop control there, so live updates use
     `WorkspaceEdit` too and granularity is best-effort (documented
     limitation). The document becomes dirty; it is never saved for the user.
4. **Several gestures on one document** (a key gesture on one slider while
   another is dragged, a one-shot edit beside it): applier writes to one
   document are serialised and each change event is attributed to the
   gesture that wrote it; every *other* gesture on that document shifts its
   span (or aborts when the change overlaps it), exactly as for a user edit.
   **External edits**: `onDidChangeTextDocument` events not produced by our
   own applies are user edits. A user edit that
   intersects the active gesture's target range aborts the gesture
   (`editRejected "Edited in the editor"`). Otherwise user edits schedule a
   re-query (debounced 150 ms) for the cursor row and the pins of that
   document; state pushes never touch focused inputs (webview rule above).
   `editBegin` is rejected if the user typed inside the target range less
   than 400 ms ago.
5. After `editEnd`, re-query once to refresh ranges/anchors. Queries for a
   document are deferred while a gesture runs on it and always released when
   the gesture ends, even if it wrote nothing.
6. When the webview is disposed or re-created (`ready`), gestures it left
   open are ended (what they wrote stays, the undo group is closed), so the
   document's queries are not blocked forever.

---

## 7. Cursor tracking and state

- Active GLSL editor = `window.activeTextEditor` when its language is
  `glsl`; otherwise the last one (focusing the webview keeps it).
- Triggers: selection change (debounce 60 ms, respects
  `glslLsp.values.followCursor`), active editor change (immediate), document
  change (150 ms), view becoming visible (immediate), server restart.
  Requests carry a sequence number; stale responses are dropped. Nothing is
  queried while the view is hidden (pins are refreshed when it shows).
- One request per document: `{uri, position?, anchors}` — the active
  document gets the cursor position plus its pins' anchors; other documents
  with pins are re-resolved on their own changes.
- Each resolution stores the refreshed anchor back into the pin
  (workspaceState write debounced 500 ms).
- State pushes are coalesced to one per animation frame (~16 ms).
- Context key `glslLsp.values.hasPins` drives the *Unpin All* action.

### Pins

- Stored in `workspaceState[PINS_STATE_KEY]` as `StoredPin[]` (display
  order). `pin` appends; duplicates (same uri + same resolved target range,
  same childIndex) are not added — the existing pin flashes instead
  (`notice "Already pinned"`).
- `glslLsp.pinValue` pins the cursor target (works with the view hidden; it
  reveals the view without focus and shows `notice "Pinned <label>"`).

### Pin anchoring (server, `resolveAnchors`)

For each anchor, in this order:

1. **declaration** — when `declName` and `declKind` ∈ {iUniform, const,
   global, local, define}: find that declaration in the file (locals: within
   `functionName`); its initializer's target is the match if it has the
   anchor's kind (float stays float, vecN same N; a multi stays multi).
   Multi declarations (`float sum = 0.0, amp = 0.5;`) are declarations named
   by their first variable; array elements are `lut[i]` of their array
   declaration, trusted by name only with the same source text (an element
   inserted before shifts every index).
2. **fingerprint** — lines whose `lineFingerprint(text) === anchor.fingerprint`
   (on that line the `ordinal`-th target of the anchor's kind), scored:
   same source text (`anchor.text`) +2, same previous / next non-blank line
   fingerprint +1 each, same line +1 (within 3 lines +0.5). A target in
   another function than `anchor.functionName` never matches. A candidate
   needs 3 points (1.5 when it is the only line of that shape); an equal
   best score at an equal distance is ambiguous → stale.
3. **fuzzy** — within ±200 lines, lines with similarity
   `1 - levenshtein(fp, anchor.fp) / max(len)` ≥ 0.75, same scoring, always 3
   points.
4. **none** → `target: null` (stale), anchor returned unchanged.

`anchor.strict` is set by the client when a multi-line edit removed or
replaced the pinned line: steps 2 and 3 then require the same text, so a
neighbour sliding into the deleted line's place never takes over the pin.
The client also shifts `anchor.line` on every document change (lines
inserted/deleted above), so the true line is normally at distance 0.
Anchors stored before `text` existed keep the old nearest-line behaviour.

Steps 2 and 3 never accept a line whose target is a *different* declaration
of the same kind (anchor `u_speed`, candidate `#iUniform float u_zoom`): the
next-best line is tried instead, and if none remains the pin goes stale. So
deleting a pinned declaration makes it stale rather than silently retargeting
a near-identical neighbour (renaming a pinned declaration also makes it stale).

Fingerprints replace numbers with `#`, so the pin survives its own value
edits; declarations survive moving code around; line hints make edits above
the pin cheap. A child pin of a multi/palette stores `childIndex` plus a
`ChildKey` (component texts, name, index from the end): the child with the
same texts wins (a literal inserted before it does not retarget the pin);
with a changed value, the same index when the structure is unchanged; else
stale.

---

## 8. Detection (server)

`computeValueTargets(env, params)`. Offsets via `model.lines`; use
`model.calls` (constructors: `isConstructor`, `args` ranges), `model.tokens`
(number tokens), `model.directives` (#define, #iUniform bodies are not
parsed into calls) and `core/resolve.ts`.

**Targets** (what can be edited):

- *float*: a float/int number literal token, with a directly preceding unary
  minus (previous significant token is `(`, `,`, `=`, an operator, `return`,
  `?`, `:`). Excluded contexts: `#version`, `#if/#elif` conditions,
  `#iChannel`, `layout(...)`, array sizes/subscripts `[...]`, `for (...)`
  headers (ints), swizzle-like member access, macro-guard defines without
  value. Integer literals are targets only directly under the cursor (rule
  c), never children of a multi.
- *vec2/3/4*: constructor `vecN(...)` / `colorN(...)` (also inside `#define`
  and `#iUniform` default) with ≥1 literal argument and either 1 argument
  (splat) or N scalar arguments. Constructors with nested vectors
  (`vec4(col, 1.0)`) are not vec targets (their literals can be floats).
- *palette*: (call) a call with ≥4 args whose last 4 args are vec3 targets
  with all-editable components, and (callee contains `pal` or the call has
  exactly 5 args); (expression) `A + B * cos(K * (C * t + D))` (also
  `t * C + D`) with K within 0.01 of 2π (`6.28318`, `6.28`), `TAU`,
  `2.0*PI`, `PI*2.0` or a numeric `2.0*3.14159`, whitespace tolerant.
  A..D are vec3 literal constructors or variables declared
  `vec3 x = vec3(<literals>);` before the expression (then the children
  are those declarations, and the edit span covers them). A and B may be
  scalar literals (`0.5 + 0.5 * cos(...)`): a splat vec3 child without
  `ctor`, which the client wraps in `vec3(...)` once the channels differ.
  C may be omitted (`(t + D)`): child c is `implicit: true` (value 1, read
  only; the editor shows it locked and offers only presets with c = 1).
  Children a, b, c, d (`name: 'a'..'d'`). A/B specs read as colors
  (`colorish`), C/D do not, also for the variable declarations themselves
  when the palette cannot be built (e.g. one of them is a parameter).
- *#iUniform*: the default value only (not `in {}` bounds), plus
  `uniform: {declaredType, min, max, step}`; `color3/color4` → colorish.

**Cursor priority** at position p (first match wins):

1. inside a palette range → palette;
2. innermost vec target whose range contains p (p may touch the end) → vecN,
   unless p is on a literal inside a *locked* argument of that vector
   (`vec2(5.2, 1.3 - t * 0.|15)`): that literal is a float target of its own
   (also a child of the statement multi);
3. number literal touching p → float;
4. identifier at p resolving (`resolveSymbolAt`, across includes) to a
   variable/uniform/#define whose initializer is exactly one target → that
   target (its `uri` may be another file; `declKind` accordingly);
5. the statement containing p (previous `;`/`{`/`}` to next `;`, or the
   whole directive line) has ≥2 non-integer targets → multi (children = the
   statement's top-level targets in order, vec constructors as one child;
   `activeChild` = nearest to p); exactly 1 → that target;
6. otherwise the nearest target on p's line; else null.

**Metadata**: `name` from the declaration, assignment target (`col` in
`col.rgb = ...`), parameter name for call arguments (builtin or user
function signature; a generic one — `x`, `y`, `a`, `angle` — becomes
`<assigned var> · callee(param)`, e.g. `sun · normalize`, `col · mix(y)`),
`#define` name, `lut[i]` for array constructor elements; siblings of a multi
sharing a name get ` #1`, ` #2`; `declKind`, `functionName`;
`colorish` from `features/colors.ts` heuristics (`plausiblyColor`), true for
color3/color4 uniforms and for names where `looksLikeColorName` even with
HDR values; also true for color-map stops (array elements in [0,1] inside a
color-map function / array / color file) and for a variable that later
reaches `fragColor`; false for the input of `hsv2rgb`-style conversions and
for `fragColor` of a self-feeding buffer pass (`#iChannelN "self"`); `snippet` whitespace-collapsed ≤ 48 chars; `id` =
`${kind}:${line}:${character}`; `anchor` built from the target (ordinal
among same-kind targets on its line).

Performance: one request must stay < 5 ms on a 2 000-line file (no full
re-lex; reuse the model).

---

## 9. Visual design

Native look first: only `--vscode-*` theme variables, no hard-coded colors
except the color picker's own gradients and white/black marker rings.
Tokens live in `webview/src/styles.css` `:root` (`--gv-*`):

| Token | Value | Use |
| --- | --- | --- |
| `--gv-space-1..5` | 2, 4, 8, 12, 16 px | 4 px grid |
| `--gv-gutter` | 12 px | left/right padding, matches tree indent |
| `--gv-row-height` / `--gv-header-height` / `--gv-input-height` | 22 px | list rows, section headers, inputs |
| `--gv-widget-min-height` | 236 px | reserved widget area |
| `--gv-canvas-max` | 280 px | canvas size cap |
| `--gv-radius-sm` / `--gv-radius` | 2 / 4 px | inputs & buttons / canvases & strips |
| `--gv-font`, `--gv-font-size` | `--vscode-font-family`, 13 px | UI text |
| `--gv-font-size-small` | 11 px | section headers, badges, range fields |
| `--gv-mono`, `--gv-mono-size` | `--vscode-editor-font-family`, 12 px | numbers (`font-variant-numeric: tabular-nums`) |
| `--gv-fast` / `--gv-medium` | 90 / 160 ms, `--gv-ease` | hover/selection fades, pin flash, widget cross-fade; 0 with `prefers-reduced-motion` |

Theme variables used (via the `--gv-*` roles): `foreground`,
`descriptionForeground`, `sideBar-background`, `list-hoverBackground`,
`list-activeSelectionBackground/Foreground`,
`list-inactiveSelectionBackground/Foreground`, `focusBorder`,
`textLink-foreground`, `widget-border`, `contrastBorder`,
`contrastActiveBorder`, `editorWarning-foreground`, `errorForeground`,
`icon-foreground`, `toolbar-hoverBackground`, `input-background/foreground/border`,
`inputOption-activeBackground/Border` (segmented control),
`button-background/foreground/hoverBackground`,
`button-secondaryBackground/Foreground` (Normalize, presets),
`sideBarSectionHeader-background/foreground/border`, `editor-background`
(canvas backdrop), `editorIndentGuide-background1` (grid),
`charts-red/green/blue/yellow` (axes), `widget-shadow` (menus).

Canvas rules: size the backing store to `cssSize × devicePixelRatio` (watch
`matchMedia('(resolution: …dppx)')` and a `ResizeObserver`), draw in CSS
pixels after `setTransform(dpr,…)`; read theme colors with
`getComputedStyle(document.body)` and redraw on theme change (observe
`document.body` `class` attribute: `vscode-light/dark/high-contrast`).
Lines 1 px at half-pixel offsets. Redraw with `requestAnimationFrame` only
when dirty.

Transitions: row background 90 ms; widget switch = 120 ms opacity
cross-fade with the old widget kept in place (no height change); pin flash
160 ms. Nothing animates during drags.

Icons: inline SVG strings (codicon-like 16 px, `currentColor`, 1.2 px
strokes) in `webview/src/icons.ts`: pin, pinned, close, warning, go-to-file,
chevron, back, color, vector, reset, preset. No external fetches; CSP is
`default-src 'none'; style-src cspSource; img-src cspSource data:; font-src
cspSource; script-src 'nonce-…'` — so **no inline `style="…"` attributes in
HTML strings and no `<style>` tags**; set styles via `element.style.*`
(CSSOM is allowed) or classes.

Accessibility: list `role=listbox` + `aria-activedescendant`, rows
`role=option` `aria-selected`; sliders `role=slider` with
`aria-valuemin/max/now/text`; canvases have `tabindex=0`, a role and
`aria-label`; icon buttons have `aria-label` + `title`.

---

## 10. Components

Webview (`webview/src`):

| Module | Responsibility |
| --- | --- |
| `main.ts` | bootstrap, message pump, `setState` persistence, layout shell (`list` + `widget` regions) |
| `store.ts` | latest `StateMessage`, selection, gesture bookkeeping, optimistic values |
| `bridge.ts` | typed `post`, gesture helpers (`begin/update/end/once`, throttle with trailing flush) |
| `list/List.ts`, `list/Row.ts`, `list/preview.ts` | sections, rows, glyphs, previews, scrubbing, keyboard |
| `widgets/Widget.ts` | widget host: picks widget by kind/mode, header, cross-fade, empty states |
| `widgets/FloatSlider.ts` | slider + range fields |
| `widgets/Trackpad.ts` | vec2 |
| `widgets/ColorPicker.ts` | S/V, hue, alpha, hex, HDR intensity |
| `widgets/Trackball.ts` | direction picker |
| `widgets/SliderStack.ts` | multi + locked fallback |
| `widgets/PaletteEditor.ts` | gradient, curves, a/b/c/d rows, presets |
| `ui/NumberInput.ts`, `ui/Segmented.ts`, `ui/IconButton.ts`, `ui/canvas.ts` (dpr, theme colors) | primitives |
| `math/color.ts`, `math/vec.ts`, `math/palette.ts` | pure: rgb↔hsv↔hex, quaternions/arcball, palette eval (unit-tested) |
| `icons.ts`, `styles.css` | icons, tokens and styles |

Client (`client/src/values`):

| Module | Responsibility |
| --- | --- |
| `index.ts` | `registerValues(context, getClient)`: wiring, commands, context key |
| `provider.ts`, `html.ts` | webview view + HTML shell (CSP, nonce) |
| `controller.ts` | rows, selection, message handling, state push coalescing |
| `cursor.ts` | active editor tracking, debounced `glslLsp/valueTargets` requests |
| `pins.ts` | `PinStore` (workspaceState), anchor refresh, dedupe |
| `edits.ts` | `EditApplier`: gestures, coalescing, offsets bookkeeping, undo strategy |
| `editText.ts` | pure: component values → text edits (splat expansion, formatting) |
| `nudge.ts` / `nudgeCore.ts` | commands / pure "number at column" + increment |

Server (`server/src/features/values*`):

| Module | Responsibility |
| --- | --- |
| `values.ts` | `register(ctx)`: the request handler (exists) |
| `values/targets.ts` | `computeValueTargets(env, params)` (exists as stub) |
| `values/literals.ts` | number tokens, unary minus, exclusion contexts |
| `values/vectors.ts` | vec/color constructors (calls + directive bodies) |
| `values/palette.ts` | palette shapes |
| `values/cursor.ts` | cursor priority rules, multi |
| `values/anchors.ts` | anchor creation + resolution |
| `values/labels.ts` | name/declKind/param names/snippet/colorish |

---

## 11. File ownership (parallel build)

Each agent edits **only** its files. Contract files are frozen; if a change
is unavoidable, make it additive (new optional field / new message) and
report it in `requests`.

| Owner | Files |
| --- | --- |
| **architect** (done, frozen) | `shared/valuesProtocol.ts`, `shared/valuesMath.ts`, `test/valuesMath.test.ts`, `docs/VALUES.md`, `scripts/build.mjs`, `tsconfig.json`, `webview/tsconfig.json`, `webview/src/env.d.ts`, `package.json`, `.vscodeignore`, `media/values.svg`, `server/src/server.ts`, `server/src/settings.ts`, `client/src/extension.ts` |
| **server-detection** | `server/src/features/values.ts`, `server/src/features/values/**`, `test/values.server*.test.ts` (e.g. `values.server.detect.test.ts`, `values.server.anchors.test.ts`). May add **exports only** (no behavior change) to `server/src/features/colors.ts` (e.g. `plausiblyColor`, `splitArgs`). |
| **client-controller** | `client/src/values/**` (incl. the existing `index.ts`, `provider.ts`, `html.ts` stubs), `test/values.client*.test.ts` (pure modules only — tests must not import `vscode`) |
| **webview-ui** | `webview/src/**` except `env.d.ts` (incl. the existing `main.ts`, `styles.css` stubs), `test/values.webview*.test.ts` (pure `math/*` modules) |
| **integration** (after the three) | `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, e2e tests |

Interfaces between agents are only the shared files: the server returns
`ValueTargetsResult`; the client turns it into `RowState`s and
`StateMessage`s; the webview renders those and emits `WebviewToExtension`.
Agents can work against hand-written fixtures of these types.

Done criteria for every agent: `npm run build`, `npm run typecheck` and
`npm test` pass; no new runtime dependencies (the webview is plain TS +
DOM + canvas); nothing outside `glsl-lsp/` is modified.
