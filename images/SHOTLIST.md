# Screenshots and recordings

This folder holds the images used by `README.md` and `docs/*.md`. This file
lists what exists, how it was captured, and what is still missing.

## Before publishing

- The images are **not** in the `.vsix`: `.vscodeignore` is an allow list and
  `images/` is not on it. vsce rewrites relative links such as
  `images/hover.png` to
  `https://github.com/PabloDeGroot/glsl-lsp/raw/HEAD/images/hover.png`, so the
  Marketplace, the VS Code extension page and Open VSX load them from GitHub.
- Commit and push `images/` to the default branch **before** `vsce publish`,
  or the listing shows broken images.
- Never rename or delete an image that a published version uses: older
  listings keep pointing at `raw/HEAD/images/<name>`. Add new names instead.
- PNG, GIF or WebP only. No SVG in README/CHANGELOG (badges from
  img.shields.io or vsmarketplacebadges.dev are the exception).
- File names: lowercase `a-z 0-9 - _ .` only.

## What exists

All are dark theme and captured at 1.5x pixel density. The README embeds
them with an explicit `width` (900 for stills, 667 for `autoinclude.gif`) so
they are sharp on high-density screens.

| File | Size | Shows | Used in |
| --- | --- | --- | --- |
| `autoinclude.gif` | 1000x622, ~830 KB | Typing `snoi` in a plain `#version 330 core` fragment shader; the completion list shows LYGIA's `snoise`, `snoise2`, `snoise3` with their file paths; accepting inserts `#include "../lygia/generative/snoise.glsl"` at the top. | README top (until `hero.gif` exists), docs/features.md |
| `hover.png` | 1500x700 | Hover on LYGIA `boxSDF`: both overloads, description, Usage block, Contributors, "Defined in lygia/sdf/boxSDF.glsl:15"; `b:` `s:` `k:` inlay hints visible. | README "Hover docs from your own comments", docs/features.md |
| `signature.png` | 1500x420 | Signature help for `smoothstep`, overload 2/4, active parameter highlighted, Khronos reference link; `edge0:` `edge1:` inlay hints. | README "Signature help and inlay hints", docs/features.md |
| `quickfix.png` | 1500x555 | `snoise(uv)` underlined as undeclared, Quick Fix *Add #include "../lygia/generative/snoise.glsl"*. | README "Diagnostics and quick fixes", docs/features.md, docs/diagnostics.md |
| `diagnostics.png` | 2080x700 | Problems panel with two glslang errors for `float bad = vec3(1.0) * ray;`. | README "Diagnostics and quick fixes", docs/diagnostics.md |
| `values-color.png` | 1750x830 | Values panel in the side bar, color picker (SV square, hue strip, hex `#FF8C33`, R/G/B fields) for `vec3 tint = vec3(1.0, 0.55, 0.2)` next to the editor. | README "Values panel", docs/values-panel.md |
| `values-widgets.png` | 1923x830 | Five Values widgets side by side, captured in VS Code: color picker (`tint`), float slider (`smin` `k`), direction trackball (`lightDir`), vec2 trackpad (`sunPos`), cosine palette editor (`sky.frag` palette). | README "Values panel", docs/values-panel.md |
| `format.png` | 2206x560 | Before/after of Format Document (opinionated mode) on a cramped fragment shader. | README "A formatter that respects your alignment", docs/formatting.md |

### How they were captured

- An isolated VS Code (`--user-data-dir` and `--extensions-dir` in a
  throwaway folder), with no extension other than glsl-lsp.
- An X virtual display of 2160x1350 with `window.zoomLevel` 2.2 (a factor of
  about 1.49), which gives a 1440x900 logical window at 1.5x density.
- Demo workspace: `shaders/scene.frag` (a plain `#version 330 core`
  raymarching shader with `u_time`, `u_resolution`, `out vec4 fragColor`),
  `shaders/sky.frag` (cosine palette, `sunPos`, `sunDir`),
  `shaders/messy.frag` (for the formatter), `lib/raymarch.glsl` (`smin`,
  `struct Ray`, `cameraRay`) and a copy of LYGIA in `lygia/`
  (`git clone https://github.com/patriciogonzalezvivo/lygia.git`). The files
  are below, so you can recreate it for new shots.

<details>
<summary>Demo workspace files</summary>

`shaders/scene.frag`:

```glsl
#version 330 core

#include "../lib/raymarch.glsl"
#include "../lygia/sdf/sphereSDF.glsl"
#include "../lygia/sdf/boxSDF.glsl"

uniform float u_time;       // seconds since start
uniform vec2  u_resolution; // viewport size in pixels

out vec4 fragColor;

// Distance from `p` to the scene: a box melting into an orbiting sphere.
float map(vec3 p) {
    float box  = boxSDF(p, vec3(0.6, 0.4, 0.5)) - 0.1;
    float ball = sphereSDF(p - vec3(sin(u_time) * 0.9, 0.35, 0.0), 0.35);
    return smin(box, ball, 0.25);
}

vec3 normalAt(vec3 p) {
    vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(map(p + e.xyy) - map(p - e.xyy),
                          map(p + e.yxy) - map(p - e.yxy),
                          map(p + e.yyx) - map(p - e.yyx)));
}

void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution) / u_resolution.y;
    Ray ray = cameraRay(uv, vec3(2.0, 1.5, 3.0), vec3(0.0), 1.8);

    vec3 lightDir = normalize(vec3(0.6, 0.8, 0.4));
    vec3 tint = vec3(1.0, 0.55, 0.2);
    vec3 col = vec3(0.08, 0.09, 0.12);

    float t = 0.0;
    for (int i = 0; i < 96; i++) {
        vec3 p = ray.origin + ray.direction * t;
        float d = map(p);
        if (d < 0.001) {
            float diffuse = max(dot(normalAt(p), lightDir), 0.0);
            col = tint * (0.15 + 0.85 * diffuse);
            break;
        }
        t += d;
    }

    float vignette = smoothstep(1.6, 0.4, length(uv));
    fragColor = vec4(pow(col * vignette, vec3(0.4545)), 1.0);
}
```

`shaders/sky.frag`:

```glsl
#version 330 core

uniform float u_time;
uniform vec2  u_resolution;

out vec4 fragColor;

// Cosine palette by Inigo Quilez: a + b * cos(2pi * (c * t + d)).
vec3 palette(float t) {
    return vec3(0.5) + vec3(0.5) * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.67)));
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec2 sunPos = vec2(0.7, 0.65);
    vec3 sunDir = normalize(vec3(0.3, 0.9, -0.4));
    float glow = exp(-8.0 * distance(uv, sunPos));
    vec3 col = palette(uv.y * 0.8 + u_time * 0.05) + glow;
    fragColor = vec4(col, 1.0);
}
```

`shaders/messy.frag`:

```glsl
#version 330 core
uniform vec2 u_resolution;
out vec4 fragColor;
float circle(vec2 p,float r){
return length(p)-r;
}
void main(){
vec2 uv=(gl_FragCoord.xy*2.0-u_resolution)/u_resolution.y;
float d=circle(uv,0.5);
if(d<0.0){
fragColor=vec4(1.0,0.5,0.2,1.0);
}else{
fragColor=vec4(0.1,0.1,0.12,1.0);
}
}
```

`lib/raymarch.glsl`:

```glsl
#ifndef LIB_RAYMARCH
#define LIB_RAYMARCH

// Smooth minimum: blends two distances over a radius of `k`.
// Larger `k` gives a softer, rounder seam between the shapes.
float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

// A camera ray through pixel `uv` (centred, y in [-1, 1]).
struct Ray {
    vec3 origin;    // camera position
    vec3 direction; // normalized
};

// Builds a ray looking from `eye` towards `target` with a field of view of `zoom`.
Ray cameraRay(vec2 uv, vec3 eye, vec3 target, float zoom) {
    vec3 f = normalize(target - eye);
    vec3 r = normalize(cross(vec3(0.0, 1.0, 0.0), f));
    vec3 u = cross(f, r);
    return Ray(eye, normalize(uv.x * r + uv.y * u + zoom * f));
}

#endif
```

</details>

- User settings:

```json
{
  "workbench.colorTheme": "Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.layoutControl.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "window.commandCenter": false,
  "window.titleBarStyle": "custom",
  "window.restoreWindows": "none",
  "window.zoomLevel": 2.2,
  "editor.minimap.enabled": false,
  "editor.fontFamily": "'JetBrainsMono Nerd Font', 'DejaVu Sans Mono', monospace",
  "editor.fontSize": 15,
  "editor.lineHeight": 22,
  "editor.stickyScroll.enabled": false,
  "editor.lightbulb.enabled": "on",
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": "off",
  "extensions.ignoreRecommendations": true,
  "chat.disableAIFeatures": true,
  "chat.commandCenter.enabled": false,
  "git.enabled": false,
  "workbench.editor.enablePreview": false
}
```

To match these on your own screen, keep everything except `window.zoomLevel`
and pick the zoom from your display scale so the result is again 1.5x:
`zoomLevel = log(1.5 / scale) / log(1.2)`. Scale 1.0 → `2.2`, scale 1.5 →
`0`, scale 2.0 → `-1.6`. Pin the window to 1440x900 logical (on KDE: Alt+F3 →
More Actions → Configure Special Window Settings → Size).

Set up a throwaway instance like this:

```sh
npm run package
D=/tmp/vsc-shots
code --user-data-dir $D/data --extensions-dir $D/ext --install-extension glsl-intellisense-0.4.0.vsix
code --user-data-dir $D/data --extensions-dir $D/ext --install-extension stevensona.shader-toy   # hero only
# put the settings above in $D/data/User/settings.json, then:
code --user-data-dir $D/data --extensions-dir $D/ext ~/path/to/demo-workspace
```

## Still needed

### 1. Hero GIF: `images/hero.gif` (most important)

The first thing a visitor sees. It should show what no other GLSL extension
does: dragging a widget in the Values panel rewrites the number in the code
and a live preview changes with it.

- **Where it goes**: the top of README.md, replacing the
  `<!-- TODO(owner): record images/hero.gif ... -->` comment under the badges.
  Move `autoinclude.gif` down into the "Completion that writes the `#include`"
  section at the same time, and use:

  ```html
  <img src="images/hero.gif" width="900" alt="Dragging a color picker and a slider in the Values panel rewrites the numbers in a GLSL shader while the preview updates live">
  ```

- **Layout** (left to right, about 1440x800 logical): the Values panel in the
  side bar (about 300 px) | the editor (about 650 px) | the preview (about
  450 px). Hide the bottom panel (Ctrl+J).
- **Preview**: the reliable option is the shader-toy extension
  (`stevensona.shader-toy`): open the file and run **GLSL: Show Shadertoy
  Preview** (button in the editor title). It needs a `mainImage` shader,
  which is what the snippet below is. If you prefer a non-Shadertoy look, any
  hot-reloading preview works (for example glsl-canvas with a WebGL shader),
  but check that it reloads on every edit and not only on save.
- **Code on screen** (`hero.glsl`, self-contained so the preview cannot fail
  on an include):

  ```glsl
  // Rings colored by a cosine palette.
  vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
      return a + b * cos(6.28318 * (c * t + d));
  }

  void mainImage(out vec4 fragColor, in vec2 fragCoord) {
      vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;

      vec3 tint = vec3(1.0, 0.55, 0.2);
      float rings = 6.0;
      float speed = 0.4;

      float r = length(uv);
      float wave = sin(6.28318 * (r * rings - iTime * speed));
      vec3 col = palette(r + iTime * 0.05,
                         vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5),
                         vec3(1.0, 1.0, 1.0), vec3(0.00, 0.33, 0.67));
      col *= tint * (0.6 + 0.4 * wave);
      col *= smoothstep(1.4, 0.3, r);
      fragColor = vec4(col, 1.0);
  }
  ```

- **Beats** (6-10 s total, mouse pointer visible):
  1. Cursor on `tint`: the color picker shows. Drag in the SV square from
     orange towards teal; the rings recolor.
  2. Click `6.0` in `rings`: drag the slider; the ring count changes.
  3. Optionally click inside the `palette(...)` call and pick a preset in the
     palette editor.
  4. Drag back to the starting values so the loop is seamless.
- **Budget**: 1000 px wide, 12-15 fps, 3 MB or less.

### 2. Values widgets strip: `images/values-widgets.png` (done)

Already captured (see the table above). Recapture it only if the widgets change; use the same five values of the demo workspace so the alt text in README.md and docs/values-panel.md stays true.

### 3. Optional: rename across files: `images/rename.gif`

- **Where it goes**: README "Navigate and refactor across includes" (it has
  no image yet).
- **Editor state**: split editor, `shaders/scene.frag` on the left,
  `lib/raymarch.glsl` on the right, both scrolled so the `smin` definition and
  its call `return smin(box, ball, 0.25);` are visible.
- **Beats**: Ctrl+click `smin` in `scene.frag` (jumps to `lib/raymarch.glsl`);
  go back (**Go Back**, Ctrl+Alt+- on Linux); F2 on `smin`, type `smoothMin`, Enter; both files
  update. Turn on **Developer: Toggle Screencast Mode** so the keys show.
- **Budget**: 900-1000 px wide, 6-8 s, 1.5 MB or less.

### 4. Optional: pins: `images/values-pins.gif`

- **Where it goes**: docs/values-panel.md, the "Pins" section.
- **Beats**: in `scene.frag`, pin `tint` with the pin button on the cursor
  row; move the cursor to the `0.25` in `smin(...)` and pin it; open
  `sky.frag`; click the pinned `tint` row and drag the color. The pinned
  value keeps editing `scene.frag` while another file is open.
- **Budget**: about 900 px wide, 8-10 s, 2 MB or less.

### 5. Optional: light theme

The Marketplace cannot switch images by theme (no `<picture>`), so one light
image is only useful to show that the Values panel follows the theme. If you
want one, capture `values-color.png` again with **Light Modern** as
`images/values-color-light.png` and use it in docs/values-panel.md only.

### 6. GitHub social preview (not in the README)

- 1280x640 PNG, under 1 MB, uploaded in the GitHub repository under
  Settings → General → Social preview. It is what Discord, X, Mastodon and
  Slack show when someone shares the repository link.
- Background `#1B1340` (the Marketplace banner color in `package.json`), the
  icon `media/icon.png` and "GLSL IntelliSense" on the left, a crop of
  `values-color.png` or a frame of `hero.gif` on the right. Keep text and the
  icon at least 40 px from the edges; some sites crop.
- Save the source as `images/social-preview.png` if you want it versioned.

## Recording and converting

On KDE Plasma (Wayland), Spectacle's **Rectangular Region** recording is the
simplest; OBS and Kooha also work. `wf-recorder` only works on wlroots
compositors (Sway, Hyprland), not on KDE. Record WebM or MP4, then convert:

```sh
sudo pacman -S gifski gifsicle pngquant oxipng

# gifski (best quality)
mkdir -p /tmp/f && ffmpeg -i hero.webm -vf "fps=15,scale=1000:-1:flags=lanczos" /tmp/f/%04d.png
gifski --fps 15 --quality 85 --width 1000 -o images/hero.gif /tmp/f/*.png
gifsicle -b -O3 --lossy=40 images/hero.gif   # in place; only if it is over budget

# ffmpeg only (palettegen)
ffmpeg -i hero.webm -vf "fps=15,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 images/hero.gif

# PNG stills
pngquant --quality 70-90 --skip-if-larger --force --ext .png images/*.png
oxipng -o 4 --strip safe images/*.png
```

Start and end each GIF on the same frame so the loop does not jump. Show the
mouse pointer only in drag shots.
