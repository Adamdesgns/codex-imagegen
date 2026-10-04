// End-to-end tests: run imagegen.mjs as a subprocess against the STUB codex.
// The real Codex is never used here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makePng, runCli, STUB, tempDir } from './helpers.mjs';

function setup() {
  const work = tempDir('cxig-work-');
  return { work, out: path.join(work, 'images', 'mug.png'), log: path.join(work, 'images', 'SOURCES.md') };
}

test('happy path: saves the image, reports real size, prints ONE JSON object, cleans up its scratch dir', () => {
  const { out } = setup();
  const r = runCli(['--prompt', 'a small blue mug on a white table', '--out', out], { env: { STUB_SIZE: '64x48', STUB_THREAD: 'thread-ok' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split(/\r?\n/).length, 1, 'exactly one line on stdout');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.out, out);
  assert.equal(r.json.width, 64);
  assert.equal(r.json.height, 48);
  assert.equal(r.json.thread_id, 'thread-ok');
  assert.equal(r.json.codex_version, '9.9.9-stub');
  assert.equal(typeof r.json.seconds, 'number');
  assert.ok(r.json.source.includes(path.join('generated_images', 'thread-ok')));
  assert.ok(fs.statSync(out).size > 0);
  assert.match(r.stderr, /saved/);

  // what the stub was asked
  assert.equal(r.record.length, 1);
  const call = r.record[0];
  assert.match(call.stdin, /^Use your built-in image generation tool exactly once/);
  assert.match(call.stdin, /IMAGE PROMPT:\na small blue mug on a white table$/);
  assert.ok(call.args.includes('--ignore-user-config'));
  assert.ok(call.args.includes('--ephemeral'));
  assert.ok(call.args.includes('--skip-git-repo-check'));
  assert.ok(call.args.includes('--json'));
  assert.equal(call.cwdExists, true, 'scratch dir existed during the run');
  assert.equal(fs.existsSync(call.cwd), false, 'scratch dir removed afterwards');
});

test('never overwrites: a second run into the same name lands in name-2.png and the original is untouched', () => {
  const { out } = setup();
  const home = tempDir('cxig-home-');
  const first = runCli(['--prompt', 'one', '--out', out], { home, env: { STUB_SIZE: '10x10' } });
  const firstBytes = fs.readFileSync(out);
  const second = runCli(['--prompt', 'two', '--out', out], { home, env: { STUB_SIZE: '20x20' } });
  const third = runCli(['--prompt', 'three', '--out', out], { home, env: { STUB_SIZE: '30x30' } });
  assert.equal(first.status, 0);
  assert.equal(path.basename(second.json.out), 'mug-2.png');
  assert.equal(path.basename(third.json.out), 'mug-3.png');
  assert.deepEqual(fs.readFileSync(out), firstBytes);
  assert.equal(second.json.width, 20);
  assert.equal(third.json.width, 30);
});

test('wrong extension in --out is replaced by the real one and reported', () => {
  const { work } = setup();
  const r = runCli(['--prompt', 'x', '--out', path.join(work, 'pic.jpg')], { env: { STUB_FORMAT: 'png' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(path.basename(r.json.out), 'pic.png');

  const j = runCli(['--prompt', 'x', '--out', path.join(work, 'photo.png')], { env: { STUB_FORMAT: 'jpg', STUB_SIZE: '33x22' } });
  assert.equal(path.basename(j.json.out), 'photo.jpg');
  assert.equal(j.json.width, 33);
  assert.equal(j.json.height, 22);
});

test('--log appends an entry each run and never rewrites the earlier one; reference images are attached with --image=FILE', () => {
  const { work, out, log } = setup();
  const ref = path.join(work, 'refs', 'character.png');
  fs.mkdirSync(path.dirname(ref), { recursive: true });
  fs.writeFileSync(ref, makePng(8, 8));
  const promptFile = path.join(work, 'prompt.txt');
  fs.writeFileSync(promptFile, 'A calm original character, vertical 9:16.\nNo text.\n');
  const home = tempDir('cxig-home-');

  const a = runCli(['--prompt-file', promptFile, '--out', out, '--log', log, '--image', ref], { home, env: { STUB_THREAD: 't-a' } });
  assert.equal(a.status, 0, a.stderr);
  const afterFirst = fs.readFileSync(log, 'utf8');
  const b = runCli(['--prompt', 'second prompt', '--out', out, '--log', log], { home, env: { STUB_THREAD: 't-b' } });
  assert.equal(b.status, 0, b.stderr);
  const afterSecond = fs.readFileSync(log, 'utf8');

  assert.ok(afterSecond.startsWith(afterFirst), 'first entry untouched');
  assert.match(afterFirst, /- File: mug\.png \(48x32\)/);
  assert.match(afterFirst, /- Thread: t-a/);
  assert.match(afterFirst, /- Codex: 9\.9\.9-stub/);
  assert.match(afterFirst, /- Reference images: character\.png/);
  assert.match(afterFirst, /A calm original character, vertical 9:16\.\nNo text\./);
  assert.match(afterSecond, /- File: mug-2\.png/);
  assert.match(afterSecond, /- Reference images: none/);
  assert.match(afterSecond, /second prompt/);

  const call = a.record[0];
  assert.equal(call.refs.length, 1);
  assert.match(call.refs[0].arg, /--image=.*ref-1.png$/, 'attached as a copy named ref-1.png in the temp dir');
  assert.ok(call.refs[0].exists, 'the copy existed while Codex ran');
  assert.equal(call.refs[0].sha1, createHash('sha1').update(fs.readFileSync(ref)).digest('hex'), 'same bytes as the original');
  assert.match(call.stdin, /attached image as the visual reference/);
  assert.equal(b.record[1].args.some((x) => x.startsWith('--image')), false);
});

test('--use-user-config and --keep-session drop the matching Codex flags', () => {
  const { out } = setup();
  const r = runCli(['--prompt', 'x', '--out', out, '--use-user-config', '--keep-session'], {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.record[0].args.includes('--ignore-user-config'), false);
  assert.equal(r.record[0].args.includes('--ephemeral'), false);
});

test('tolerates a BOM, non-JSON lines and a retry notice from Codex', () => {
  const { out } = setup();
  const bom = runCli(['--prompt', 'x', '--out', out], { env: { STUB_MODE: 'bom', STUB_THREAD: 'bom-thread' } });
  assert.equal(bom.status, 0, bom.stderr);
  assert.equal(bom.json.thread_id, 'bom-thread');
  const retry = runCli(['--prompt', 'x', '--out', path.join(path.dirname(out), 'retry.png')], { env: { STUB_MODE: 'retry' } });
  assert.equal(retry.status, 0, retry.stderr);
});

test('falls back to a path named in the final message when there is no thread folder', () => {
  const { out } = setup();
  const r = runCli(['--prompt', 'x', '--out', out], { env: { STUB_MODE: 'msgpath' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json.source.includes('elsewhere'));
});

test('exit 1: no arguments, missing prompt, missing --out, unknown flag, missing reference file', () => {
  const { work, out } = setup();
  for (const argv of [[], ['--out', out], ['--prompt', 'x'], ['--bogus'], ['--prompt', 'x', '--out', out, '--image', path.join(work, 'nope.png')]]) {
    const r = runCli(argv);
    assert.equal(r.status, 1, JSON.stringify(argv));
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, 1);
    assert.ok(r.json.error);
  }
  assert.equal(fs.existsSync(out), false);
});

test('exit 2: Codex cannot be found (bad --codex and bad CODEX_BIN)', () => {
  const { work, out } = setup();
  const missing = path.join(work, 'no-such-codex.exe');
  const viaFlag = runCli(['--prompt', 'x', '--out', out, '--codex', missing], { withStub: false });
  assert.equal(viaFlag.status, 2);
  assert.equal(viaFlag.json.code, 2);
  assert.match(viaFlag.json.hint, /Install Codex/);
  const viaEnv = runCli(['--prompt', 'x', '--out', out], { withStub: false, env: { CODEX_BIN: missing } });
  assert.equal(viaEnv.status, 2);
});

test('--codex works with a .mjs stub and beats a bad CODEX_BIN', () => {
  const { out } = setup();
  const r = runCli(['--prompt', 'x', '--out', out, '--codex', STUB], { withStub: false, env: { CODEX_BIN: 'definitely-missing' } });
  assert.equal(r.status, 0, r.stderr);
});

test('exit 3: not signed in gives the Codex error and a `codex login` hint', () => {
  const { out } = setup();
  const r = runCli(['--prompt', 'x', '--out', out], { env: { STUB_MODE: 'auth' } });
  assert.equal(r.status, 3);
  assert.equal(r.json.code, 3);
  assert.match(r.json.error, /401 Unauthorized/);
  // the stub is not "codex on PATH", so the hint must name the exact program to run
  assert.match(r.json.hint, /login/);
  assert.ok(r.json.hint.includes(STUB), 'hint names the resolved Codex path');
  assert.equal(fs.existsSync(out), false);
});

test('exit 3: a Codex crash with no events still reports stderr', () => {
  const { out } = setup();
  const r = runCli(['--prompt', 'x', '--out', out], { env: { STUB_MODE: 'crash' } });
  assert.equal(r.status, 3);
  assert.match(r.json.error, /exit code 7/);
  assert.match(r.json.error, /stub exploded/);
});

test('exit 4: no image produced reports what Codex said', () => {
  const { out } = setup();
  const r = runCli(['--prompt', 'x', '--out', out], { env: { STUB_MODE: 'refuse' } });
  assert.equal(r.status, 4);
  assert.equal(r.json.code, 4);
  assert.match(r.json.error, /content policy/);
  assert.match(r.json.hint, /change one thing/);
  assert.equal(fs.existsSync(out), false);
});

test('exit 5: a hung Codex is killed at the timeout', () => {
  const { out } = setup();
  const started = Date.now();
  const r = runCli(['--prompt', 'x', '--out', out, '--timeout-sec', '1'], { env: { STUB_MODE: 'hang' } });
  assert.equal(r.status, 5, r.stderr);
  assert.equal(r.json.code, 5);
  assert.match(r.json.error, /Timed out after 1 seconds/);
  assert.ok(Date.now() - started < 30000, 'returned promptly');
  const call = r.record[0];
  assert.equal(fs.existsSync(call.cwd), false, 'scratch dir removed after a timeout');
});

test('--doctor: reports Node, CODEX_HOME, codex path, version and login; exit 0 when usable', () => {
  const r = runCli(['--doctor']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Node:\s+v\d+/);
  assert.match(r.stdout, /CODEX_HOME:/);
  assert.match(r.stdout, /Codex:\s+.*stub-codex\.mjs/);
  assert.match(r.stdout, /Version:\s+9\.9\.9-stub/);
  assert.match(r.stdout, /Login:\s+Logged in using ChatGPT/);
  assert.match(r.stdout, /Usable:\s+yes/);
});

test('--doctor: exit 3 when signed out, exit 2 when Codex is missing', () => {
  const out = runCli(['--doctor'], { env: { STUB_MODE: 'auth' } });
  assert.equal(out.status, 3);
  assert.match(out.stdout, /NOT SIGNED IN/);
  assert.match(out.stdout, /Usable:\s+no/);
  const gone = runCli(['--doctor', '--codex', path.join(tempDir(), 'nope.exe')], { withStub: false });
  assert.equal(gone.status, 2);
  assert.match(gone.stdout, /NOT FOUND/);
});

test('--help prints usage and exits 0', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Exit codes/);
  assert.match(r.stdout, /--prompt-file/);
});
