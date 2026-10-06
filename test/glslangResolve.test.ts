// Finding glslangValidator: PATH only for a bare name (never the current
// directory, which is where a cloned repository could plant its own binary).
import { describe, expect, it } from 'vitest';
import { resolveExecutable, runGlslang } from '../server/src/features/diagnostics/glslang';

const only = (...files: string[]) => (p: string) => files.includes(p);

describe('resolveExecutable on POSIX', () => {
  const env = { PATH: '/usr/local/bin:/usr/bin' };

  it('looks a bare name up on PATH, in order', () => {
    const isExecutable = only('/usr/bin/glslangValidator', '/usr/local/bin/glslangValidator');
    expect(resolveExecutable('glslangValidator', { env, platform: 'linux', isExecutable })).toBe('/usr/local/bin/glslangValidator');
  });

  it('never searches the current directory or relative PATH entries', () => {
    const cwdCopy = `${process.cwd()}/glslangValidator`;
    expect(resolveExecutable('glslangValidator', { env, platform: 'linux', isExecutable: only(cwdCopy) })).toBeUndefined();
    const relative = { PATH: '.:bin:/usr/bin' };
    expect(resolveExecutable('glslangValidator', { env: relative, platform: 'linux', isExecutable: only('glslangValidator', 'bin/glslangValidator') })).toBeUndefined();
  });

  it('uses absolute paths as they are and resolves relative ones against baseDir', () => {
    expect(resolveExecutable('/opt/vulkan/bin/glslangValidator', { env, platform: 'linux', isExecutable: only('/opt/vulkan/bin/glslangValidator') })).toBe(
      '/opt/vulkan/bin/glslangValidator',
    );
    const isExecutable = only('/ws/tools/glslangValidator');
    expect(resolveExecutable('tools/glslangValidator', { env, platform: 'linux', baseDir: '/ws', isExecutable })).toBe('/ws/tools/glslangValidator');
    // Without a base folder (untrusted workspace) a relative path resolves to nothing.
    expect(resolveExecutable('tools/glslangValidator', { env, platform: 'linux', isExecutable })).toBeUndefined();
  });
});

describe('resolveExecutable on Windows', () => {
  const env = { Path: 'C:\\VulkanSDK\\Bin;C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('tries the PATHEXT extensions in each PATH folder', () => {
    const isExecutable = only('C:\\VulkanSDK\\Bin\\glslangValidator.exe');
    expect(resolveExecutable('glslangValidator', { env, platform: 'win32', isExecutable })).toBe('C:\\VulkanSDK\\Bin\\glslangValidator.exe');
    expect(resolveExecutable('glslangValidator', { env, platform: 'win32', isExecutable: only('C:\\Windows\\glslangValidator.cmd') })).toBe(
      'C:\\Windows\\glslangValidator.cmd',
    );
  });

  it('accepts quoted PATH entries', () => {
    const quoted = { Path: '"C:\\VulkanSDK\\Bin";C:\\Windows', PATHEXT: '.EXE' };
    const isExecutable = only('C:\\VulkanSDK\\Bin\\glslangValidator.exe');
    expect(resolveExecutable('glslangValidator', { env: quoted, platform: 'win32', isExecutable })).toBe('C:\\VulkanSDK\\Bin\\glslangValidator.exe');
  });

  it('ignores a validator in the opened folder', () => {
    const planted = only('C:\\repo\\glslangValidator.exe', 'glslangValidator.exe');
    expect(resolveExecutable('glslangValidator', { env, platform: 'win32', isExecutable: planted })).toBeUndefined();
  });

  it('keeps an explicit extension', () => {
    const isExecutable = only('C:\\tools\\glslang.bat', 'C:\\tools\\glslang.bat.exe');
    expect(resolveExecutable('C:\\tools\\glslang.bat', { env, platform: 'win32', isExecutable })).toBe('C:\\tools\\glslang.bat');
  });
});

describe('runGlslang', () => {
  it('says where it looked when the validator is missing', async () => {
    expect(await runGlslang('void main(){}', { exe: 'definitely-not-a-real-glslang-binary', stage: 'frag' })).toEqual({
      ok: false,
      reason: 'missing',
      detail: "'definitely-not-a-real-glslang-binary' was not found on PATH",
    });
    expect(await runGlslang('void main(){}', { exe: './nope/glslangValidator', stage: 'frag' })).toMatchObject({
      reason: 'missing',
      detail: "'./nope/glslangValidator' does not exist or is not executable",
    });
  });
});
