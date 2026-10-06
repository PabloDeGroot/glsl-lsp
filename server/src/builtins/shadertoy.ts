// The Shadertoy environment (uniforms, entry points), the stevensona
// shader-toy VS Code extension extras (#iKeyboard helpers, Key_* constants)
// and the Wallpaper Engine inputs used by the sibling project. Everything here
// is flagged `shadertoy: true` so glslLsp.shadertoy.enable can hide it.

import { fn } from './define';
import type { BuiltinFunction, BuiltinVariable } from './types';

const STOY = 'https://www.shadertoy.com/howto';

function u(name: string, type: string, doc: string, extra: Partial<BuiltinVariable> = {}): BuiltinVariable {
  return { kind: 'variable', name, type, qualifiers: ['uniform'], shadertoy: true, doc, docUrl: STOY, ...extra };
}

const channel = (n: number): BuiltinVariable =>
  u(`iChannel${n}`, 'sampler2D', `Input texture ${n}: an image, a buffer pass, a video, a keyboard texture or audio, as bound by \`#iChannel${n}\` (shader-toy extension) or the Shadertoy UI. Sample with \`texture(iChannel${n}, uv)\`; cubemaps are \`samplerCube\` on Shadertoy.`);

export const shadertoyVariables: BuiltinVariable[] = [
  u('iResolution', 'vec3', 'Viewport resolution in pixels: `xy` is width and height, `z` is the pixel aspect ratio (usually `1.0`).'),
  u('iTime', 'float', 'Shader playback time in seconds.'),
  u('iTimeDelta', 'float', 'Time it took to render the previous frame, in seconds.'),
  u('iFrameRate', 'float', 'Current frame rate in frames per second.'),
  u('iFrame', 'int', 'Current frame number, starting at 0.'),
  u('iChannelTime', 'float[4]', 'Playback time in seconds of each input channel (meaningful for video and audio inputs).'),
  u('iChannelResolution', 'vec3[4]', 'Resolution in pixels of each input channel: `iChannelResolution[0].xy` is the size of `iChannel0`.'),
  u(
    'iMouse',
    'vec4',
    'Mouse state in pixels. `xy` is the current position while the button is held down (and the last position afterwards). `zw` is the position of the last click: `z` is positive while the button is held, `w` is positive only on the frame of the click; both become negative on release. So `iMouse.z > 0.0` means "button down".',
  ),
  channel(0),
  channel(1),
  channel(2),
  channel(3),
  u('iDate', 'vec4', 'Current date: `x` year, `y` month (0 to 11), `z` day of month, `w` seconds since midnight.'),
  u('iSampleRate', 'float', 'Sound sample rate, typically `44100.0`.'),

  // Wallpaper Engine inputs of the sibling project (see lib/engine.glsl).
  u('iMousePrev', 'vec2', 'Wallpaper engine: the cursor position at the previous update, in pixels (same space as `fragCoord`).', { docUrl: undefined }),
  u('iMouseButton', 'vec4', 'shader-toy extension uniform with the mouse button state. Not available in the wallpaper engine.', { docUrl: undefined }),
  u('iScreenOffset', 'vec2', 'Wallpaper engine: offset in pixels of this screen within the whole desktop.', { docUrl: undefined }),
  u('iScreenIndex', 'int', 'Wallpaper engine: index of the screen being rendered.', { docUrl: undefined }),
  u('iScreenCount', 'int', 'Wallpaper engine: number of screens.', { docUrl: undefined }),
  u('iWindowCount', 'int', 'Wallpaper engine: number of open windows reported, 0 to 16.', { docUrl: undefined }),
  u('iWindowRects', 'vec4[16]', 'Wallpaper engine: window rectangles as `(x, y, width, height)` in pixels; `(x, y)` is the bottom-left corner, y up, the same space as `fragCoord`.', { docUrl: undefined }),
  u('iWindowRectsPrev', 'vec4[16]', 'Wallpaper engine: each window\'s rectangle at the previous update, in the same layout as `iWindowRects`.', { docUrl: undefined }),
  u('iWindowVelocities', 'vec2[16]', 'Wallpaper engine: velocity of each window in pixels per second.', { docUrl: undefined }),
];
for (const e of shadertoyVariables) if (e.docUrl === undefined) delete e.docUrl;

// ---- #iKeyboard: key constants (JavaScript key codes), as in the shader-toy extension.
const KEYS: [string, number, string][] = [
  ['Backspace', 8, 'Backspace'], ['Tab', 9, 'Tab'], ['Enter', 13, 'Enter'], ['Shift', 16, 'Shift'], ['Ctrl', 17, 'Control'],
  ['Alt', 18, 'Alt'], ['Pause', 19, 'Pause'], ['CapsLock', 20, 'Caps Lock'], ['Escape', 27, 'Escape'], ['Space', 32, 'Space bar'],
  ['PageUp', 33, 'Page Up'], ['PageDown', 34, 'Page Down'], ['End', 35, 'End'], ['Home', 36, 'Home'],
  ['LeftArrow', 37, 'Left arrow'], ['UpArrow', 38, 'Up arrow'], ['RightArrow', 39, 'Right arrow'], ['DownArrow', 40, 'Down arrow'],
  ['Insert', 45, 'Insert'], ['Delete', 46, 'Delete'],
  ['Multiply', 106, 'Numpad *'], ['Add', 107, 'Numpad +'], ['Subtract', 109, 'Numpad -'], ['DecimalPoint', 110, 'Numpad .'], ['Divide', 111, 'Numpad /'],
  ['NumLock', 144, 'Num Lock'], ['ScrollLock', 145, 'Scroll Lock'],
  ['SemiColon', 186, ';'], ['Equal', 187, '='], ['Comma', 188, ','], ['Dash', 189, '-'], ['Period', 190, '.'], ['ForwardSlash', 191, '/'],
  ['GraveAccent', 192, '`'], ['OpenBracket', 219, '['], ['BackSlash', 220, '\\'], ['CloseBracket', 221, ']'], ['SingleQuote', 222, "'"],
];
for (let i = 0; i <= 9; i++) {
  KEYS.push([String(i), 48 + i, `Digit ${i}`]);
  KEYS.push([`Numpad${i}`, 96 + i, `Numpad ${i}`]);
}
for (let i = 0; i < 26; i++) {
  const c = String.fromCharCode(65 + i);
  KEYS.push([c, 65 + i, `${c} key`]);
}
for (let i = 1; i <= 12; i++) KEYS.push([`F${i}`, 111 + i, `F${i}`]);

export const keyboardVariables: BuiltinVariable[] = KEYS.map(([name, code, label]) => ({
  kind: 'variable',
  name: `Key_${name}`,
  type: 'int',
  qualifiers: ['const'],
  shadertoy: true,
  requiresDirective: 'iKeyboard',
  value: String(code),
  doc: `Key code of ${label} (\`${code}\`), for \`isKeyDown\`, \`isKeyPressed\`, \`isKeyToggled\` and \`isKeyReleased\`. Needs \`#iKeyboard\`.`,
}));

const KEY_FN = (name: string, doc: string): BuiltinFunction =>
  fn(name, 'shadertoy', `${doc} Needs the \`#iKeyboard\` directive of the shader-toy extension.`, [`bool ${name}(int key)`], {
    shadertoy: true,
    requiresDirective: 'iKeyboard',
    docPage: false,
    params: { key: 'Key code, e.g. `Key_A`.' },
  });

export const shadertoyFunctions: BuiltinFunction[] = [
  KEY_FN('isKeyDown', 'True while the key is held down.'),
  KEY_FN('isKeyPressed', 'True only on the frame the key goes down.'),
  KEY_FN('isKeyReleased', 'True only on the frame the key is released.'),
  KEY_FN('isKeyToggled', 'Toggles every time the key is pressed (like a caps-lock state).'),

  fn('mainImage', 'entrypoint', 'Shadertoy image entry point, called once per pixel. Write the colour to `fragColor` (alpha is usually `1.0`); `fragCoord` is the pixel position, `0.5, 0.5` at the bottom-left pixel.', ['void mainImage(out vec4 fragColor, in vec2 fragCoord)'], {
    shadertoy: true,
    docPage: false,
    snippet: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n\tvec2 uv = fragCoord / iResolution.xy;\n\t$0\n\tfragColor = vec4(uv, 0.0, 1.0);\n}',
    params: { fragColor: 'Output colour of the pixel.', fragCoord: 'Pixel coordinate in `[0, iResolution.xy]`.' },
  }),
  fn('mainSound', 'entrypoint', 'Shadertoy sound entry point, called per audio sample. Return left and right channel amplitudes in `[-1, 1]` for time `time` seconds. `samp` is the sample index within the block.', ['vec2 mainSound(int samp, float time)'], {
    shadertoy: true,
    docPage: false,
    snippet: 'vec2 mainSound(int samp, float time) {\n\treturn vec2(sin(6.2831853 * 440.0 * time) * 0.2);\n}',
    params: { samp: 'Sample index within the block.', time: 'Time of the sample in seconds.' },
  }),
  fn('mainVR', 'entrypoint', 'Shadertoy VR entry point: set `fragColor` for a pixel given the ray origin and direction in world space.', ['void mainVR(out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir)'], {
    shadertoy: true,
    docPage: false,
    snippet: 'void mainVR(out vec4 fragColor, in vec2 fragCoord, in vec3 fragRayOri, in vec3 fragRayDir) {\n\t$0\n\tfragColor = vec4(fragRayDir * 0.5 + 0.5, 1.0);\n}',
  }),
];
