# Values panel

Sliders, color pickers and vector widgets for the numbers in your shader. Drag a widget and the literal in your code changes.

[← Back to README](../README.md)

<img src="../images/values-color.png" width="800" alt="The Values panel in the side bar editing vec3 tint = vec3(1.0, 0.55, 0.2) with a color picker: saturation/brightness square, hue strip, hex #FF8C33 and R/G/B fields">

- [Open the panel](#open-the-panel)
- [How editing works](#how-editing-works)
- [The values list](#the-values-list)
- [Pins](#pins)
- [Widgets](#widgets)
- [Keyboard](#keyboard)
- [Nudge a number without the panel](#nudge-a-number-without-the-panel)
- [Settings](#settings)

## Open the panel

Click the **GLSL** icon (sliders) in the Activity Bar, or run **GLSL: Focus Values Panel** from the Command Palette. The panel is a normal VS Code view, so you can drag it to the Secondary Side Bar or the bottom Panel.

The idea comes from [glslEditor](https://github.com/patriciogonzalezvivo/glslEditor) by Patricio Gonzalez Vivo.

## How editing works

- Dragging a widget rewrites the literal in the document live, about 30 times a second (`glslLsp.values.throttleMs`).
- Each drag is **one undo step**. Press `Escape` during a drag to cancel it and restore the old value.
- If you type in the same spot while a drag is running, the drag stops. Your typing is never overwritten.
- Floats always keep a `.` (`2.0`) and trailing zeros are trimmed. The number of decimals follows the widget step, up to `glslLsp.values.maxDecimals`. A value too small for that limit is written with an exponent (`1e-5`), not rounded to `0.0`.
- Components that are not plain literals, such as `t` in `vec3(t, 0.5, 1.0)`, are shown locked.

### See the result while you drag

The panel only edits text. To see the shader change as you drag, keep a live preview open next to the editor. Any tool that reloads when the shader changes works:

- the [shader-toy](https://marketplace.visualstudio.com/items?itemName=stevensona.shader-toy) extension, which reloads on every edit (lower `shader-toy.reloadOnEditTextDelay`, 1 second by default, for a faster response),
- a browser dev server with hot reload (Vite, webpack) for WebGL or three.js,
- glslViewer, or your engine's own file watcher.

The panel does not save the file. Tools that watch the file on disk only see a change after it is saved, so turn on auto-save for them:

```jsonc
"files.autoSave": "afterDelay",
"files.autoSaveDelay": 200
```

If the preview stutters while you drag, raise `glslLsp.values.throttleMs`.

## The values list

The top of the panel is a list of values.

- **Cursor** (always the first row): the value under or nearest the editor cursor. It can be a float literal, a `vec2`/`vec3`/`vec4` constructor, a `#define`, an `#iUniform` default (Shadertoy) or an iq cosine palette. The row follows the cursor as you move.
- **Pinned**: values you keep at hand while you edit somewhere else. See [Pins](#pins).

Each row shows a name (the variable, uniform or a short code snippet), the file name when it is not the active file, and a small preview: a color swatch, the numbers, or an arrow for a direction.

In a row you can work with the numbers directly:

- Drag a number sideways to scrub it. Shift scrubs in bigger steps, Alt in smaller ones.
- Double-click a number to type a new value. `Enter` applies it, `Escape` cancels.
- Double-click elsewhere on the row to show the value in the editor.
- Lines with several numbers, and palettes, expand into one sub-row per value.

Below the list is the **widget** for the selected row. The cursor row is selected by default. When you click a pin, the widget shows that pin and stays on it while the cursor moves. To follow the cursor again, click the cursor row, click the **← Cursor** button in the widget header, or press `Escape`.

## Pins

Pin a value to keep it in the list while you work elsewhere in the file, or in another file.

- **Pin**: click the pin button on the cursor row, press `P` in the list, or run **GLSL: Pin Value at Cursor**. The command is also in the editor right-click menu and the panel title bar.
- **Unpin**: click the × on the row, press `Delete` (or `Backspace`) in the list, or run **GLSL: Unpin All Values** from the panel title bar.
- **Reorder**: `Alt+↑` / `Alt+↓` in the list (`Option+↑` / `Option+↓` on macOS).

Pins are saved per workspace. A pin is found again by its declaration name (`#iUniform u_speed`, `const float K`, a local `col`), otherwise by the shape of its line. It survives edits above it and changes to its value. If the value is deleted, the pin shows *not found* instead of jumping to a different value.

A pin in another file keeps working. Dragging its widget edits that file even when it is not open in an editor.

**GLSL: Pin Value at Cursor** opens the panel if you have opened it before. If you never have, the value is pinned anyway and the status bar says so. Open the **GLSL** view to see it.

## Widgets

<img src="../images/values-widgets.png" width="900" alt="Five Values widgets side by side: a color picker, a float slider for smin k, a direction trackball for lightDir, a vec2 trackpad for sunPos and a cosine palette editor with gradient, r/g/b curves and a/b/c/d rows">

The widget depends on the kind of value.

| Value | Widget |
| --- | --- |
| `float` | Slider and number field. The range comes from shader-toy's `#iUniform ... in { min, max }` (read-only), otherwise from an automatic range around the value. Type a min or max to set your own range; the reset button goes back to the automatic one. |
| `vec2` | 2D trackpad with grid and axes, an editable range and X/Y fields. |
| `vec3` / `vec4` color | Saturation/brightness square, hue strip, alpha strip for `vec4`, hex field and R/G/B(/A) fields. An intensity slider appears for HDR colors with components above 1. Click the old color swatch to revert. |
| `vec3` / `vec4` direction | Trackball: drag to point the vector. *Keep length* (on by default) keeps its length while you rotate; turned off, rotating writes a unit vector. *Normalize* scales it to length 1. A `vec4` also gets a W slider. |
| Several numbers on a line | One slider per number. A vector with non-literal or integer components also uses this layout, with locked components read-only. |
| iq cosine palette: `palette(t, a, b, c, d)` or `a + b*cos(6.28318*(c*t+d))` | Gradient strip, r/g/b curves, a/b/c/d rows (offset, amplitude, frequency, phase) and a **Presets** menu. |

A `vec3` or `vec4` opens as a color when it looks like one: a `color3`/`color4` `#iUniform`, a name such as `col`, `tint` or `rgb` (the same name check as the color decorators in the editor), or a value between 0 and 1 that ends up in the shader output. With `glslLsp.colors.mode` set to `all`, every `vec3`/`vec4` whose components are all between 0 and 1 opens as a color. The **Color | Vector** toggle in the widget header switches a value between the two widgets.

### Mouse

| Widget | Action |
| --- | --- |
| Slider | Click to jump, or drag the thumb. Shift drags in fine steps. Double-click the thumb to reset. |
| Trackpad | Click to jump, or drag the handle. Shift drags in fine steps, Ctrl snaps to the grid, Ctrl+wheel zooms the range. Double-click the handle to reset. |
| Trackball | Drag to rotate the vector. Shift snaps to 15°, Ctrl snaps to the nearest axis or 45° diagonal. Alt-drag, or drag with the right or middle button, orbits the view. Double-click the tip to reset the vector; double-click outside the ball to reset the view. |

*Reset* goes back to the value the number had when you first selected or edited it in this session.

In the panel, modifier keys are the physical keys on every platform: on macOS, Ctrl is Control (not Cmd) and Alt is Option.

## Keyboard

In the list:

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move through rows (`Home` / `End` for the first and last) |
| `→` / `←` | Expand or collapse a row |
| `Enter` | Show the value in the editor |
| `P` | Pin or unpin |
| `Delete` / `Backspace` | Unpin |
| `Alt+↑` / `Alt+↓` | Move a pin up or down |
| `Escape` | Go back to the cursor row |

In a focused widget, the arrow keys adjust the value. Shift makes the step bigger; on sliders, the trackpad and the trackball, Alt makes it smaller. Sliders also accept `Page Up` / `Page Down` (10 steps) and `Home` / `End` (range minimum and maximum). Several key presses in a row are one undo step.

## Nudge a number without the panel

These commands change the number under the cursor in the editor. They work with multiple cursors.

| Command | Windows / Linux | macOS |
| --- | --- | --- |
| **GLSL: Increment Number at Cursor** | `Ctrl+Alt+Up` | `Ctrl+Option+Up` |
| **GLSL: Decrement Number at Cursor** | `Ctrl+Alt+Down` | `Ctrl+Option+Down` |
| **GLSL: Increment Number at Cursor (x10)** | `Ctrl+Shift+Alt+Up` | `Ctrl+Shift+Option+Up` |
| **GLSL: Decrement Number at Cursor (x10)** | `Ctrl+Shift+Alt+Down` | `Ctrl+Shift+Option+Down` |

The keys are active only in GLSL editors. The step is the literal's last decimal place: `0.25` steps by `0.01`, `3` steps by `1`.

<details>
<summary>Conflicts with other shortcuts</summary>

On Windows, `Ctrl+Alt+Up/Down` is VS Code's *Add Cursor Above/Below*. On Windows and Linux, `Ctrl+Shift+Alt+Up/Down` is column selection. In a GLSL editor the keys nudge only when the cursor is on a number (with several cursors: when every cursor is on a number). Otherwise they run the platform's default command, so adding cursors keeps working.

In a Remote session (WSL, SSH, Dev Containers) opened from Windows, this fallback follows the remote machine's platform, not Windows. There, `Ctrl+Alt+Up/Down` off a number does nothing instead of adding a cursor. Rebind the nudge keys if you use them for cursors.

Some graphics drivers and desktop environments take `Ctrl+Alt+Arrow` (for screen rotation or workspace switching) before VS Code sees it.

To use other keys, open **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`, `Cmd+K Cmd+S` on macOS) and rebind `glslLsp.nudgeUp`, `glslLsp.nudgeDown`, `glslLsp.nudgeUpLarge` and `glslLsp.nudgeDownLarge`.

</details>

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `glslLsp.values.followCursor` | `true` | Update the cursor row as the cursor moves. When off, it updates when you switch editors or run **GLSL: Focus Values Panel**. |
| `glslLsp.values.throttleMs` | `33` | Minimum milliseconds between document edits while dragging (33 ms is about 30 per second). Raise it if the live preview stutters. |
| `glslLsp.values.maxDecimals` | `4` | Maximum decimals the panel writes. Trailing zeros are trimmed. A literal that already has more decimals keeps its precision. |

All settings are listed in [Configuration](configuration.md). The design notes behind the panel are in [VALUES.md](VALUES.md).
