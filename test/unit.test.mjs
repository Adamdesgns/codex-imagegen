import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendLog,
  buildCodexArgs,
  buildTask,
  chooseDestination,
  CliError,
  copyWithoutOverwrite,
  EXIT,
  extractImagePaths,
  findGeneratedImage,
  findOnPath,
  formatLogEntry,
  imageSize,
  launcherFor,
  loadRequest,
  parseArgs,
  parseCodexOutput,
  resolveCodex,
  sniffImageType,
} from '../skills/codex-imagegen/scripts/imagegen.mjs';
import { makeJpeg, makePng, makeWebp, tempDir } from './helpers.mjs';

// --- arguments -------------------------------------------------------------

test('parseArgs: collects repeated --image and understands --name=value', () => {
  const o = parseArgs(['--prompt', 'a mug', '--out=x.png', '--image', 'a.png', '--image=b.png', '--timeout-sec', '30', '--keep-session']);
  assert.equal(o.prompt, 'a mug');
  assert.equal(o.out, 'x.png');
  assert.deepEqual(o.images, ['a.png', 'b.png']);
  assert.equal(o.timeoutSec, 30);
  assert.equal(o.keepSession, true);
  assert.equal(o.useUserConfig, false);
});

test('parseArgs: rejects unknown flags, missing values and bad timeouts with exit code 1', () => {
  for (const argv of [['--nope'], ['--prompt'], ['--prompt', '--out', 'x.png'], ['--timeout-sec', 'abc'], ['--timeout-sec', '0'], ['--doctor=1']]) {
    assert.throws(() => parseArgs(argv), (e) => e instanceof CliError && e.code === EXIT.ARGS, JSON.stringify(argv));
  }
});

test('loadRequest: needs a prompt and --out, not both prompt styles, and real reference files', () => {
  const dir = tempDir();
  const ref = path.join(dir, 'ref.png');
  fs.writeFileSync(ref, makePng(4, 4));
  const promptFile = path.join(dir, 'p.txt');
  fs.writeFileSync(promptFile, '\uFEFF  a blue mug  \r\n');

  const ok = loadRequest(parseArgs(['--prompt-file', promptFile, '--out', path.join(dir, 'o.png'), '--image', ref]));
  assert.equal(ok.prompt, 'a blue mug');
  assert.deepEqual(ok.images, [ref]);

  const bad = (argv) => assert.throws(() => loadRequest(parseArgs(argv)), (e) => e instanceof CliError && e.code === EXIT.ARGS);
  bad(['--out', 'o.png']);
  bad(['--prompt', 'x']);
  bad(['--prompt', 'x', '--prompt-file', promptFile, '--out', 'o.png']);
  bad(['--prompt', '   ', '--out', 'o.png']);
  bad(['--prompt-file', path.join(dir, 'missing.txt'), '--out', 'o.png']);
  bad(['--prompt', 'x', '--out', 'o.png', '--image', path.join(dir, 'missing.png')]);
});

// --- the task text and command line ---------------------------------------

test('buildTask: matches the wording that worked, plus a reference line only when needed', () => {
  assert.equal(
    buildTask('a blue mug'),
    'Use your built-in image generation tool exactly once to generate this image. Do not run shell commands and do not edit any files. When it is done, reply with only the full file path of the saved image.\n\nIMAGE PROMPT:\na blue mug',
  );
  assert.match(buildTask('x', 1), /attached image as the visual reference for the same person, object and style/);
  assert.match(buildTask('x', 2), /attached images as the visual reference/);
  assert.ok(buildTask('x', 2).endsWith('IMAGE PROMPT:\nx'));
});

test('buildCodexArgs: default flags, opt-outs, and --image=FILE form', () => {
  const base = { scratch: '/s', lastMessageFile: '/s/last.txt' };
  const a = buildCodexArgs({ ...base, images: ['/r/a.png', '/r/b.png'] });
  assert.deepEqual(a.slice(0, 3), ['exec', '--skip-git-repo-check', '--ignore-user-config']);
  assert.ok(a.includes('--ephemeral'));
  assert.ok(a.includes('--json'));
  assert.deepEqual(a.slice(a.indexOf('-s'), a.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.deepEqual(a.slice(a.indexOf('-C'), a.indexOf('-C') + 2), ['-C', '/s']);
  assert.deepEqual(a.slice(a.indexOf('-o'), a.indexOf('-o') + 2), ['-o', '/s/last.txt']);
  assert.deepEqual(a.slice(-2), ['--image=/r/a.png', '--image=/r/b.png']);
  assert.ok(!a.includes('--image'), 'must never use the variadic space form');

  const b = buildCodexArgs({ ...base, useUserConfig: true, keepSession: true });
  assert.ok(!b.includes('--ignore-user-config'));
  assert.ok(!b.includes('--ephemeral'));
});

// --- reading codex output --------------------------------------------------

test('parseCodexOutput: BOM, noise, thread id, messages', () => {
  const text = [
    '\uFEFFReading prompt from stdin...',
    '{"type":"thread.started","thread_id":"abc-123"}',
    'not json {',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"C:\\\\x\\\\y.png"}}',
    '{"type":"turn.completed","usage":{}}',
  ].join('\r\n');
  const r = parseCodexOutput(text);
  assert.equal(r.threadId, 'abc-123');
  assert.deepEqual(r.messages, ['C:\\x\\y.png']);
  assert.equal(r.failed, false);
  assert.equal(r.events, 4);
});

test('parseCodexOutput: turn.failed and unrecovered error are failures; a retry notice is not', () => {
  assert.equal(parseCodexOutput('{"type":"turn.failed","error":{"message":"boom"}}').failed, true);
  assert.equal(parseCodexOutput('{"type":"error","message":"nope"}').failed, true);
  const retried = parseCodexOutput('{"type":"error","message":"Reconnecting 1/5"}\n{"type":"turn.completed"}');
  assert.equal(retried.failed, false);
  assert.deepEqual(retried.errors, ['Reconnecting 1/5']);
  assert.equal(parseCodexOutput('').failed, false);
});

// --- finding the image ------------------------------------------------------

test('extractImagePaths: Windows and POSIX paths, with spaces and quoting', () => {
  assert.deepEqual(extractImagePaths('C:\\Users\\Jo Smith\\.codex\\generated_images\\t\\a.png'), [
    'C:\\Users\\Jo Smith\\.codex\\generated_images\\t\\a.png',
  ]);
  const posix = extractImagePaths('Saved to `/home/jo/.codex/generated_images/t/a.webp`.');
  assert.ok(posix.includes('/home/jo/.codex/generated_images/t/a.webp'));
  assert.deepEqual(extractImagePaths('no path here'), []);
});

test('findGeneratedImage: newest file in the thread folder wins; message path is the fallback', () => {
  const home = tempDir();
  const dir = path.join(home, 'generated_images', 'thread-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.png'), makePng(2, 2));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const newer = path.join(dir, 'new.png');
  fs.writeFileSync(newer, makePng(3, 3));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(newer, later, later);

  const hit = findGeneratedImage({ codexHome: home, threadId: 'thread-1', lastMessage: '', startedAt: 0 });
  assert.equal(hit.file, newer);

  assert.equal(findGeneratedImage({ codexHome: home, threadId: '../thread-1', lastMessage: '', startedAt: 0 }), null);
  assert.equal(findGeneratedImage({ codexHome: home, threadId: 'nope', lastMessage: 'nothing', startedAt: 0 }), null);

  const elsewhere = path.join(home, 'pics', 'p.png');
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.writeFileSync(elsewhere, makePng(2, 2));
  const viaMessage = findGeneratedImage({ codexHome: home, threadId: 'nope', lastMessage: `Saved: ${elsewhere}`, startedAt: Date.now() - 1000 });
  assert.equal(viaMessage.file, elsewhere);
  // a file that was already there before this run started is not claimed
  assert.equal(findGeneratedImage({ codexHome: home, threadId: 'nope', lastMessage: elsewhere, startedAt: Date.now() + 60000 }), null);
});

// --- image headers ----------------------------------------------------------

test('imageSize: PNG, JPEG and the three WebP flavours', () => {
  assert.deepEqual(imageSize(makePng(941, 1672)), { type: 'png', width: 941, height: 1672 });
  assert.deepEqual(imageSize(makeJpeg(1024, 768)), { type: 'jpeg', width: 1024, height: 768 });
  assert.deepEqual(imageSize(makeWebp('VP8X', 1536, 1024)), { type: 'webp', width: 1536, height: 1024 });
  assert.deepEqual(imageSize(makeWebp('VP8L', 800, 600)), { type: 'webp', width: 800, height: 600 });
  assert.deepEqual(imageSize(makeWebp('VP8 ', 640, 480)), { type: 'webp', width: 640, height: 480 });
  assert.equal(imageSize(Buffer.from('not an image at all')), null);
  assert.equal(sniffImageType(Buffer.from('GIF89a......')), null);
});

test('chooseDestination: keeps a matching extension, fixes a wrong one, adds a missing one', () => {
  const png = makePng(2, 2);
  const jpg = makeJpeg(2, 2);
  assert.equal(chooseDestination('/o/a.png', '/c/x.png', png), '/o/a.png');
  assert.equal(chooseDestination('/o/a.PNG', '/c/x.png', png), '/o/a.PNG');
  assert.equal(chooseDestination('/o/a.jpg', '/c/x.png', png), '/o/a.png');
  assert.equal(chooseDestination('/o/a.png', '/c/x.jpg', jpg), '/o/a.jpg');
  assert.equal(chooseDestination('/o/a.jpeg', '/c/x.jpg', jpg), '/o/a.jpeg');
  assert.equal(chooseDestination('/o/a', '/c/x.png', png), '/o/a.png');
  assert.equal(chooseDestination('/o/a.v2', '/c/x.png', png), '/o/a.v2.png');
});

test('copyWithoutOverwrite: never replaces a file, counts up from -2', () => {
  const dir = tempDir();
  const src = path.join(dir, 'src.png');
  fs.writeFileSync(src, 'NEW');
  const dest = path.join(dir, 'sub', 'name.png');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'ORIGINAL');
  const second = copyWithoutOverwrite(src, dest);
  const third = copyWithoutOverwrite(src, dest);
  assert.equal(path.basename(second), 'name-2.png');
  assert.equal(path.basename(third), 'name-3.png');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'ORIGINAL');
  assert.equal(fs.readFileSync(second, 'utf8'), 'NEW');
  // creates missing folders
  const deep = copyWithoutOverwrite(src, path.join(dir, 'a', 'b', 'c.png'));
  assert.equal(fs.readFileSync(deep, 'utf8'), 'NEW');
});

// --- log --------------------------------------------------------------------

test('formatLogEntry: fence is longer than any backtick run in the prompt', () => {
  const entry = formatLogEntry({
    when: new Date('2026-10-03T12:00:00.000Z'),
    fileName: 'mug.png',
    width: 10,
    height: 20,
    codexVersion: '1.2.3',
    threadId: 't-1',
    refs: ['refs/a.png'],
    seconds: 12.3,
    prompt: 'a mug with ```code``` on it',
  });
  assert.match(entry, /^## 2026-10-03T12:00:00.000Z - mug.png/);
  assert.match(entry, /- File: mug.png \(10x20\)/);
  assert.match(entry, /- Codex: 1.2.3/);
  assert.match(entry, /- Thread: t-1/);
  assert.match(entry, /- Reference images: refs\/a.png/);
  assert.match(entry, /- Seconds: 12.3/);
  assert.match(entry, /````text\na mug with ```code``` on it\n````\n/);
});

test('appendLog: appends, keeps earlier entries byte-for-byte, writes a header once', () => {
  const dir = tempDir();
  const log = path.join(dir, 'deep', 'SOURCES.md');
  appendLog(log, 'ENTRY ONE\n\n');
  const afterFirst = fs.readFileSync(log, 'utf8');
  assert.ok(afterFirst.startsWith('# Image generation log\n\n'));
  appendLog(log, 'ENTRY TWO\n\n');
  const afterSecond = fs.readFileSync(log, 'utf8');
  assert.ok(afterSecond.startsWith(afterFirst));
  assert.equal(afterSecond.match(/# Image generation log/g).length, 1);

  const handWritten = path.join(dir, 'notes.md');
  fs.writeFileSync(handWritten, '# My notes\nno trailing newline');
  appendLog(handWritten, 'ENTRY\n');
  assert.equal(fs.readFileSync(handWritten, 'utf8'), '# My notes\nno trailing newline\n\nENTRY\n');
});

// --- finding and launching codex ------------------------------------------------

test('findOnPath: scans PATH, and picks .exe before .cmd on Windows', () => {
  const dirA = tempDir();
  const dirB = tempDir();
  fs.writeFileSync(path.join(dirB, 'codex.cmd'), '');
  fs.writeFileSync(path.join(dirB, 'codex.exe'), '');
  fs.writeFileSync(path.join(dirA, 'codex'), '');
  if (process.platform !== 'win32') {
    // (simulating POSIX on Windows would split "C:\..." at the drive colon, so only check it on a POSIX host)
    assert.equal(findOnPath('codex', { PATH: dirA }, 'linux'), path.join(dirA, 'codex'));
  }
  assert.equal(findOnPath('codex', { PATH: dirB }, 'win32'), path.join(dirB, 'codex.exe'));
  assert.equal(findOnPath('codex', { PATH: dirA }, 'win32'), null, 'an extensionless sh shim cannot run on Windows');
  assert.equal(
    findOnPath('codex', { PATH: `${dirA};"${dirB}"` }, 'win32'),
    path.join(dirB, 'codex.exe'),
    'Windows skips the extensionless shim in the first folder and handles a quoted PATH entry',
  );
  assert.equal(findOnPath('codex', { PATH: '' }, 'linux'), null);
});

test('resolveCodex: --codex beats CODEX_BIN; a missing explicit path is exit code 2', () => {
  const dir = tempDir();
  const real = path.join(dir, 'codex.mjs');
  fs.writeFileSync(real, '');
  const fromFlag = resolveCodex({ flag: real, env: { CODEX_BIN: path.join(dir, 'nope') } });
  assert.equal(fromFlag.bin, real);
  assert.equal(fromFlag.source, '--codex');
  assert.equal(resolveCodex({ env: { CODEX_BIN: real } }).source, 'CODEX_BIN');
  assert.throws(
    () => resolveCodex({ flag: path.join(dir, 'missing.exe') }),
    (e) => e instanceof CliError && e.code === EXIT.NOT_FOUND && /does not exist/.test(e.message),
  );
});

test('launcherFor: .mjs runs under this Node; an npm codex.cmd resolves to its .js; no shell anywhere', () => {
  assert.deepEqual(launcherFor('/x/stub.mjs'), { command: process.execPath, prefix: ['/x/stub.mjs'] });
  assert.deepEqual(launcherFor('/x/codex.exe'), { command: '/x/codex.exe', prefix: [] });

  const npmDir = tempDir();
  const js = path.join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, '');
  const shim = path.join(npmDir, 'codex.cmd');
  fs.writeFileSync(shim, '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.deepEqual(launcherFor(shim), { command: process.execPath, prefix: [js] });

  const lonely = path.join(tempDir(), 'codex.cmd');
  fs.writeFileSync(lonely, '@ECHO off\r\n');
  assert.throws(() => launcherFor(lonely), (e) => e instanceof CliError && e.code === EXIT.NOT_FOUND);
});
