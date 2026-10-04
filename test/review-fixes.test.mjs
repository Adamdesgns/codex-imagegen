// Tests for the fixes that came out of the independent review. Each one runs the
// script as a subprocess against the STUB codex; the real Codex is never used here.
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

const sha1 = (file) => createHash('sha1').update(fs.readFileSync(file)).digest('hex');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitUntilDead(pid, ms = 8000) {
  const end = Date.now() + ms;
  while (isAlive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return !isAlive(pid);
}

test('preflight: an unusable --out or --log is exit 1 BEFORE Codex runs, and the check leaves nothing behind', () => {
  const { work, out } = setup();
  const aFile = path.join(work, 'afile');
  fs.writeFileSync(aFile, 'x');
  const logDir = path.join(work, 'logdir');
  fs.mkdirSync(logDir);

  const underFile = runCli(['--prompt', 'x', '--out', path.join(aFile, 'sub', 'a.png')]);
  assert.equal(underFile.status, 1);
  assert.equal(underFile.json.code, 1);
  assert.match(underFile.json.error, /--out/);
  assert.doesNotMatch(underFile.json.error, /Unexpected error/, 'not reported as a bug or a sign-in problem');
  assert.equal(underFile.record.length, 0, 'Codex was never started, so no generation was spent');

  const logIsFolder = runCli(['--prompt', 'x', '--out', out, '--log', logDir]);
  assert.equal(logIsFolder.status, 1);
  assert.match(logIsFolder.json.error, /--log/);
  assert.equal(logIsFolder.record.length, 0);

  const logUnderFile = runCli(['--prompt', 'x', '--out', out, '--log', path.join(aFile, 'SOURCES.md')]);
  assert.equal(logUnderFile.status, 1);
  assert.equal(logUnderFile.record.length, 0);

  assert.equal(fs.existsSync(path.dirname(out)), false, 'no folder or probe file was created');
  assert.deepEqual(fs.readdirSync(work).sort(), ['afile', 'logdir']);
});

test('a made image is never lost to a late failure: a log error keeps ok:true, a save error reports `source`', () => {
  const { work, out, log } = setup();
  // The stub turns the log path into a folder after it has "generated" the image.
  const logFail = runCli(['--prompt', 'x', '--out', out, '--log', log], { env: { STUB_BREAK_LOG: log } });
  assert.equal(logFail.status, 0, logFail.stderr);
  assert.equal(logFail.json.ok, true);
  assert.ok(fs.statSync(logFail.json.out).size > 0, 'the image was saved');
  assert.match(logFail.json.log_error, /Could not write the log/);
  assert.match(logFail.stderr, /warning/);

  // The stub puts a FILE where --out's folder should be, after the preflight passed.
  const later = path.join(work, 'later');
  const saveFail = runCli(['--prompt', 'x', '--out', path.join(later, 'a.png')], { env: { STUB_BREAK_OUT: later } });
  assert.equal(saveFail.status, 1);
  assert.equal(saveFail.json.ok, false);
  assert.doesNotMatch(saveFail.json.error, /Unexpected error/);
  assert.match(saveFail.json.error, /could not be saved/);
  assert.ok(saveFail.json.source && fs.statSync(saveFail.json.source).size > 0, 'the generated image is reported and still on disk');
  assert.match(saveFail.json.hint, /Do not run again/);
});

test('a reference image with a comma in its path is attached as a comma-free copy (Codex splits --image on commas)', () => {
  const { work, out } = setup();
  const dir = path.join(work, 'Smith, Jo');
  fs.mkdirSync(dir);
  const ref = path.join(dir, 'hero, approved v2.png');
  fs.writeFileSync(ref, makePng(6, 6));
  const r = runCli(['--prompt', 'x', '--out', out, '--image', ref]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.record[0].refs.length, 1);
  const [attached] = r.record[0].refs;
  assert.equal(attached.arg.includes(','), false, 'no comma reaches Codex');
  assert.equal(attached.exists, true, 'the file Codex is pointed at exists');
  assert.equal(attached.sha1, sha1(ref), 'and holds the reference image bytes');
});

test('a relative CODEX_HOME is made absolute for Codex, so both sides look in the same place', () => {
  const { work, out } = setup();
  const r = runCli(['--prompt', 'x', '--out', out], { cwd: work, env: { CODEX_HOME: 'myhome', STUB_THREAD: 'rel1' } });
  assert.equal(r.status, 0, r.stderr + JSON.stringify(r.json));
  const mine = path.join(fs.realpathSync(work), 'myhome');
  assert.equal(fs.realpathSync(r.record[0].codexHome), mine, 'Codex was given the absolute path');
  assert.ok(fs.realpathSync(r.json.source).startsWith(mine), 'the image was found there');
});

test('--prompt-file: UTF-16 files (Windows PowerShell) are decoded; a NUL-filled file without a BOM is refused', () => {
  const { work } = setup();
  const text = 'a blue mug\r\n';
  const files = {
    le: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    be: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
    utf8bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(work, `${name}.txt`);
    fs.writeFileSync(file, bytes);
    const r = runCli(['--prompt-file', file, '--out', path.join(work, `${name}.png`)]);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.record[0].stdin, /IMAGE PROMPT:\na blue mug$/, name);
    assert.equal(r.record[0].stdin.includes('\u0000'), false, name);
  }
  const noBom = path.join(work, 'nobom.txt');
  fs.writeFileSync(noBom, Buffer.from(text, 'utf16le'));
  const bad = runCli(['--prompt-file', noBom, '--out', path.join(work, 'nobom.png')]);
  assert.equal(bad.status, 1);
  assert.match(bad.json.hint, /UTF-8/);
  assert.equal(bad.record.length, 0, 'garbage is never sent to Codex');
});

test('--timeout-sec: values a Node timer cannot honour are refused (exit 1); the largest allowed value works', () => {
  const { out } = setup();
  for (const value of ['99999999', '2147484', '0.5', '0.0001']) {
    const r = runCli(['--prompt', 'x', '--out', out, '--timeout-sec', value]);
    assert.equal(r.status, 1, value);
    assert.match(r.json.error, /from 1 to 2147483/, value);
    assert.equal(r.record.length, 0, value);
  }
  const ok = runCli(['--prompt', 'x', '--out', out, '--timeout-sec', '2147483']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /TimeoutOverflow/);
});

test('Codex output with a multi-byte character split across two chunks is decoded intact', () => {
  const { out } = setup();
  const r = runCli(['--prompt', 'x', '--out', out], { env: { STUB_MODE: 'split' } });
  assert.equal(r.status, 3);
  assert.ok(r.json.error.includes('Café quota reached'), r.json.error);
  assert.equal(r.json.error.includes('�'), false, 'no replacement characters');
});

test('exit 5: the timeout kills Codex AND everything Codex started', async () => {
  const { work, out } = setup();
  const pidFile = path.join(work, 'pids.json');
  const r = runCli(['--prompt', 'x', '--out', out, '--timeout-sec', '2'], { env: { STUB_MODE: 'hang', STUB_PIDS: pidFile } });
  assert.equal(r.status, 5, r.stderr);
  const { stub, grandchild } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await waitUntilDead(stub), 'the Codex process is gone');
  assert.ok(await waitUntilDead(grandchild), 'the process Codex started is gone too');
});

test('Codex is started with the command-running tools switched off, with and without --use-user-config', () => {
  const { work } = setup();
  for (const extra of [[], ['--use-user-config']]) {
    const r = runCli(['--prompt', 'x', '--out', path.join(work, `o${extra.length}.png`), ...extra]);
    assert.equal(r.status, 0, r.stderr);
    const args = r.record[0].args;
    for (const feature of ['shell_tool', 'computer_use', 'browser_use']) {
      const i = args.indexOf(`features.${feature}=false`);
      assert.ok(i > 0 && args[i - 1] === '-c', `${feature} is turned off with -c`);
    }
    assert.equal(args.includes('--disable'), false, 'the --disable form fails on a name Codex does not know');
    assert.deepEqual(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2), ['-s', 'read-only']);
  }
});

test('exit 4 and --doctor hints: say what to do when the problem is the plan or the app login, not the prompt', () => {
  const { out } = setup();
  const four = runCli(['--prompt', 'x', '--out', out], { env: { STUB_MODE: 'refuse' } });
  assert.match(four.json.hint, /cannot generate images/);
  assert.match(four.json.hint, /ChatGPT plan/);
  assert.match(four.json.hint, /npm install -g @openai\/codex/);

  const doctor = runCli(['--doctor'], { env: { STUB_MODE: 'auth' } });
  assert.match(doctor.stdout, /NOT SIGNED IN/);
  assert.ok(doctor.stdout.includes(STUB), 'the login advice names the exact Codex it found');
});
