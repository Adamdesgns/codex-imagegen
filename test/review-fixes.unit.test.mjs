// Unit tests for the fixes that came out of the independent review.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertFolderWritable,
  buildCodexArgs,
  CliError,
  codexChildEnv,
  decodePromptBytes,
  DISABLED_FEATURES,
  EXIT,
  launcherFor,
  loginAdvice,
  MAX_TIMEOUT_SEC,
  parseArgs,
  preflightTargets,
  referenceArg,
  resolveCodex,
  stageReferences,
} from '../skills/codex-imagegen/scripts/imagegen.mjs';
import { tempDir } from './helpers.mjs';

const isArgsError = (e) => e instanceof CliError && e.code === EXIT.ARGS;

// --- --timeout-sec ---------------------------------------------------------------------

test('parseArgs: --timeout-sec accepts 1 to 2147483 and refuses what a Node timer cannot honour', () => {
  assert.equal(parseArgs(['--timeout-sec', '1']).timeoutSec, 1);
  assert.equal(parseArgs(['--timeout-sec', String(MAX_TIMEOUT_SEC)]).timeoutSec, MAX_TIMEOUT_SEC);
  for (const bad of ['0', '0.9', '0.0001', '-5', String(MAX_TIMEOUT_SEC + 1), '99999999', 'Infinity', 'abc']) {
    assert.throws(() => parseArgs(['--timeout-sec', bad]), isArgsError, bad);
  }
  // the biggest allowed value, in milliseconds, still fits a 32-bit signed integer
  assert.ok(MAX_TIMEOUT_SEC * 1000 <= 2 ** 31 - 1);
});

// --- prompt files ------------------------------------------------------------------------

test('decodePromptBytes: UTF-8 (with or without BOM) and UTF-16 with a BOM; NULs without a BOM are refused', () => {
  assert.equal(decodePromptBytes(Buffer.from('a mug')), 'a mug');
  assert.equal(decodePromptBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), 'a');
  assert.equal(decodePromptBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('caf\u00e9 \u2615', 'utf16le')])), 'caf\u00e9 \u2615');
  assert.equal(
    decodePromptBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('caf\u00e9', 'utf16le').swap16()])),
    'caf\u00e9',
  );
  // a stray odd byte at the end of a UTF-16BE file must not throw
  assert.equal(decodePromptBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('ab', 'utf16le').swap16(), Buffer.from([0x00])])), 'ab');
  assert.throws(
    () => decodePromptBytes(Buffer.from('a mug', 'utf16le')),
    (e) => isArgsError(e) && /UTF-8/.test(e.hint),
  );
});

// --- the Codex command line --------------------------------------------------------------

test('buildCodexArgs: command-running tools are switched off with -c features.NAME=false, before the --image arguments', () => {
  for (const name of ['shell_tool', 'computer_use', 'browser_use']) assert.ok(DISABLED_FEATURES.includes(name), name);
  const args = buildCodexArgs({ scratch: '/s', lastMessageFile: '/s/l.txt', images: ['/s/ref-1.png'] });
  for (const name of DISABLED_FEATURES) {
    const i = args.indexOf(`features.${name}=false`);
    assert.ok(i > 0 && args[i - 1] === '-c', name);
    assert.ok(i < args.indexOf('--image=/s/ref-1.png'), 'image arguments stay last');
  }
  assert.equal(args.includes('--disable'), false);
  // still there when the user's own config is loaded: command-line values win over config.toml
  const withConfig = buildCodexArgs({ scratch: '/s', lastMessageFile: '/s/l.txt', useUserConfig: true });
  assert.ok(withConfig.includes('features.shell_tool=false'));
});

test('referenceArg and stageReferences: comma-free copies named ref-N, bare name if the temp dir itself has a comma', () => {
  assert.equal(referenceArg('/s', 'ref-1.png'), path.join('/s', 'ref-1.png'));
  assert.equal(referenceArg('/tmp/a,b', 'ref-1.png'), 'ref-1.png');

  const dir = tempDir();
  const src = path.join(dir, 'hero, approved v2.PNG');
  fs.writeFileSync(src, 'PNGDATA');
  const noExt = path.join(dir, 'noext');
  fs.writeFileSync(noExt, 'X');
  const scratch = tempDir();
  const args = stageReferences([src, noExt], scratch);
  assert.deepEqual(args, [path.join(scratch, 'ref-1.png'), path.join(scratch, 'ref-2')]);
  assert.equal(fs.readFileSync(args[0], 'utf8'), 'PNGDATA');
  assert.equal(fs.readFileSync(src, 'utf8'), 'PNGDATA', 'the original is untouched');
  assert.throws(() => stageReferences([path.join(dir, 'missing.png')], scratch), isArgsError);
});

test('codexChildEnv: a relative CODEX_HOME becomes absolute; an unset one is left for Codex to default', () => {
  const env = { CODEX_HOME: 'rel-home', KEEP: '1' };
  const child = codexChildEnv(env);
  assert.equal(child.CODEX_HOME, path.resolve('rel-home'));
  assert.equal(child.KEEP, '1');
  assert.equal(env.CODEX_HOME, 'rel-home', 'the caller\'s env is not modified');
  const unset = { KEEP: '1' };
  assert.equal(codexChildEnv(unset), unset);
});

// --- finding Codex -----------------------------------------------------------------------

test('resolveCodex: PATH beats the Store app, the Store app beats Codex.app, an untraceable .cmd falls through', () => {
  const exeDir = tempDir();
  fs.writeFileSync(path.join(exeDir, 'codex.exe'), '');
  const store = () => 'C:\\store\\codex.exe';
  const mustNotRun = () => assert.fail('the Store lookup must not run here');
  const macApp = path.join(tempDir(), 'codex');
  fs.writeFileSync(macApp, '');

  assert.deepEqual(resolveCodex({ env: { PATH: exeDir }, platform: 'win32', storeLookup: mustNotRun, macApp }), {
    bin: path.join(exeDir, 'codex.exe'),
    source: 'PATH',
  });
  assert.deepEqual(resolveCodex({ env: { PATH: '' }, platform: 'win32', storeLookup: store, macApp }), {
    bin: 'C:\\store\\codex.exe',
    source: 'Microsoft Store app',
  });
  assert.deepEqual(resolveCodex({ env: { PATH: '' }, platform: 'darwin', storeLookup: mustNotRun, macApp }), {
    bin: macApp,
    source: 'Codex.app',
  });

  // A codex.cmd that cannot be traced to a program is skipped, not fatal.
  const lonelyDir = tempDir();
  fs.writeFileSync(path.join(lonelyDir, 'codex.cmd'), '@ECHO off\r\n');
  assert.equal(resolveCodex({ env: { PATH: lonelyDir }, platform: 'win32', storeLookup: store }).source, 'Microsoft Store app');
  // ...and a LATER folder on PATH with a usable codex.exe still wins over the Store app
  assert.equal(
    resolveCodex({ env: { PATH: `${lonelyDir};${exeDir}` }, platform: 'win32', storeLookup: mustNotRun }).source,
    'PATH',
  );
  // With nothing else to fall back on, the error names the shim instead of saying "not found".
  assert.throws(
    () => resolveCodex({ env: { PATH: lonelyDir }, platform: 'win32', storeLookup: () => null }),
    (e) => e.code === EXIT.NOT_FOUND && /could not work out which program/.test(e.message) && e.message.includes('codex.cmd'),
  );
  assert.throws(
    () => resolveCodex({ env: { PATH: '' }, platform: 'linux' }),
    (e) => e.code === EXIT.NOT_FOUND && /Could not find the Codex CLI/.test(e.message),
  );
});

test('launcherFor: pnpm-style and older npm shims ("%~dp0\\...") resolve to their .js, wherever the package lives', () => {
  const home = tempDir();
  const pnpmJs = path.join(home, 'global', '5', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(pnpmJs), { recursive: true });
  fs.writeFileSync(pnpmJs, '');
  const shim = path.join(home, 'codex.cmd');
  fs.writeFileSync(
    shim,
    [
      '@SETLOCAL',
      '@IF EXIST "%~dp0\\node.exe" (',
      '  @SET "_prog=%~dp0\\node.exe"',
      ') ELSE (',
      '  @SET "_prog=node"',
      ')',
      '@"%_prog%"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ].join('\r\n'),
  );
  assert.deepEqual(launcherFor(shim), { command: process.execPath, prefix: [pnpmJs] });

  // a ".." hop out of the shim's folder
  const base = tempDir();
  const hopJs = path.join(base, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(hopJs), { recursive: true });
  fs.writeFileSync(hopJs, '');
  fs.mkdirSync(path.join(base, 'bin'));
  const hopShim = path.join(base, 'bin', 'codex.cmd');
  fs.writeFileSync(hopShim, '@"%_prog%" "%~dp0\\..\\lib\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.deepEqual(launcherFor(hopShim), { command: process.execPath, prefix: [hopJs] });

  // a folder called "cache.json" must not cut the path short at its ".js"
  const tricky = tempDir();
  const trickyJs = path.join(tricky, 'cache.json', 'codex.js');
  fs.mkdirSync(path.dirname(trickyJs), { recursive: true });
  fs.writeFileSync(trickyJs, '');
  const trickyShim = path.join(tricky, 'codex.cmd');
  fs.writeFileSync(trickyShim, '@"%_prog%" "%~dp0\\cache.json\\codex.js" %*\r\n');
  assert.deepEqual(launcherFor(trickyShim), { command: process.execPath, prefix: [trickyJs] });
});

// --- login advice ------------------------------------------------------------------------

test('loginAdvice: plain `codex login` only when codex really is on PATH; otherwise the exact program', () => {
  assert.match(loginAdvice({ bin: 'codex', source: 'PATH' }), /^Run `codex login`/);
  assert.match(loginAdvice(undefined), /^Run `codex login`/);

  const store = loginAdvice({ bin: 'C:\\x y\\codex.exe', source: 'Microsoft Store app' });
  assert.ok(store.includes('`"C:\\x y\\codex.exe" login`'), store);
  assert.match(store, /inside the Codex app/);
  assert.match(loginAdvice({ bin: '/Applications/Codex.app/Contents/Resources/codex', source: 'Codex.app' }), /inside the Codex app/);

  assert.ok(loginAdvice({ bin: '/x/stub.mjs', source: 'CODEX_BIN' }).includes('`node "/x/stub.mjs" login`'));
  assert.doesNotMatch(loginAdvice({ bin: '/x/codex', source: '--codex' }), /Codex app/);
});

// --- checking --out and --log before spending a generation ---------------------------------

test('assertFolderWritable and preflightTargets: refuse a file-as-folder and a folder-as-log, create nothing', () => {
  const dir = tempDir();
  assertFolderWritable(path.join(dir, 'a', 'b'), '--out');
  assert.equal(fs.existsSync(path.join(dir, 'a')), false, 'nothing was created');
  assert.deepEqual(fs.readdirSync(dir), [], 'the probe file was removed');

  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'x');
  assert.throws(() => assertFolderWritable(path.join(file, 'x', 'y'), '--out'), (e) => isArgsError(e) && /is a file/.test(e.message));

  preflightTargets({ out: path.join(dir, 'o.png'), log: path.join(dir, 'logs', 'S.md') });
  assert.throws(() => preflightTargets({ out: path.join(dir, 'o.png'), log: dir }), (e) => isArgsError(e) && /is a folder/.test(e.message));
  assert.throws(() => preflightTargets({ out: path.join(file, 'o.png') }), (e) => isArgsError(e) && /--out/.test(e.message));

  const log = path.join(dir, 'S.md');
  fs.writeFileSync(log, 'keep me');
  preflightTargets({ out: path.join(dir, 'o.png'), log });
  assert.equal(fs.readFileSync(log, 'utf8'), 'keep me', 'an existing log is opened for append, never changed');
});
