#!/usr/bin/env node
// A FAKE Codex CLI for the tests. The tests never call the real Codex.
//
// It mimics what `codex exec --json` printed in real runs (thread.started,
// turn.started, item.completed/agent_message, turn.completed) and writes a real
// PNG to <CODEX_HOME>/generated_images/<thread_id>/ like Codex does.
//
// Behaviour is chosen with env vars:
//   STUB_MODE    ok (default) | bom | retry | msgpath | refuse | auth | hang | crash | split
//   STUB_SIZE    WxH of the image it "generates" (default 48x32)
//   STUB_FORMAT  png (default) | jpg
//   STUB_THREAD  fixed thread id
//   STUB_RECORD  file to append {args, stdin, cwd, cwdExists, codexHome, refs} JSON lines to
//   STUB_PIDS    (hang mode) file to write {stub, grandchild} process ids to
//   STUB_BREAK_LOG  path to turn into a FOLDER after the image is made (so writing the log fails)
//   STUB_BREAK_OUT  path to turn into a FILE after the image is made (so saving into it fails)
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeJpeg, makePng } from './helpers.mjs';

const args = process.argv.slice(2);
// `node --test` can run every file under test/ as a test file. With no arguments, do nothing.
if (args.length === 0) process.exit(0);

const mode = process.env.STUB_MODE || 'ok';
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (args[0] === '--version') {
  console.log('codex-cli 9.9.9-stub');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (mode === 'auth') {
    console.error('Not logged in');
    process.exit(1);
  }
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (args[0] !== 'exec') {
  console.error(`stub: unsupported command ${args[0]}`);
  process.exit(64);
}

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

const cdIndex = args.indexOf('-C');
const cwdArg = cdIndex >= 0 ? args[cdIndex + 1] : null;
// What each --image=FILE argument points at, as seen NOW (the script deletes its temp dir afterwards).
const refs = args
  .filter((a) => a.startsWith('--image='))
  .map((a) => {
    const file = a.slice('--image='.length);
    const exists = fs.existsSync(file);
    return { arg: a, exists, sha1: exists ? createHash('sha1').update(fs.readFileSync(file)).digest('hex') : null };
  });
if (process.env.STUB_RECORD) {
  fs.appendFileSync(
    process.env.STUB_RECORD,
    `${JSON.stringify({
      args,
      stdin,
      cwd: cwdArg,
      cwdExists: Boolean(cwdArg && fs.existsSync(cwdArg)),
      codexHome: process.env.CODEX_HOME,
      refs,
    })}\n`,
  );
}

const home = process.env.CODEX_HOME;
const threadId = process.env.STUB_THREAD || `stub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const [width, height] = (process.env.STUB_SIZE || '48x32').split('x').map(Number);
const jpg = (process.env.STUB_FORMAT || 'png') === 'jpg';
const oIndex = args.indexOf('-o');
const lastMessageFile = oIndex >= 0 ? args[oIndex + 1] : null;

function writeImage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ig_stub.${jpg ? 'jpg' : 'png'}`);
  fs.writeFileSync(file, jpg ? makeJpeg(width, height) : makePng(width, height));
  return file;
}

function breakTargets() {
  if (process.env.STUB_BREAK_LOG) fs.mkdirSync(process.env.STUB_BREAK_LOG, { recursive: true });
  if (process.env.STUB_BREAK_OUT) fs.writeFileSync(process.env.STUB_BREAK_OUT, 'in the way');
}

function say(text) {
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  if (lastMessageFile) fs.writeFileSync(lastMessageFile, text);
}

if (mode === 'bom') process.stdout.write('﻿');
if (mode === 'bom') process.stdout.write('Reading prompt from stdin...\nsome non-JSON noise {not json\n');
emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'turn.started' });

switch (mode) {
  case 'auth':
    emit({ type: 'error', message: '401 Unauthorized: you are not logged in' });
    emit({ type: 'turn.failed', error: { message: '401 Unauthorized: you are not logged in' } });
    process.exit(1);
    break;
  case 'crash':
    console.error('stub exploded');
    process.exit(7);
    break;
  case 'refuse':
    say('I cannot create that image because it breaks the content policy.');
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  case 'split': {
    // A multi-byte character (the e-acute in "Cafe") cut in half across two writes.
    const line = Buffer.from(`${JSON.stringify({ type: 'error', message: 'Café quota reached' })}\n`, 'utf8');
    const cut = line.indexOf(0xc3) + 1;
    process.stdout.write(line.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 150));
    process.stdout.write(line.subarray(cut));
    await new Promise((r) => setTimeout(r, 150));
    process.exit(1);
    break;
  }
  case 'hang': {
    // Start a grandchild too, so a test can check the whole process tree is killed.
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    if (process.env.STUB_PIDS) {
      fs.writeFileSync(process.env.STUB_PIDS, JSON.stringify({ stub: process.pid, grandchild: grandchild.pid }));
    }
    setTimeout(() => process.exit(0), 120000); // safety net; the caller should kill us first
    await new Promise(() => {});
    break;
  }
  case 'msgpath': {
    const file = writeImage(path.join(home, 'elsewhere'));
    say(`Saved to \`${file}\``);
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  }
  case 'retry': {
    emit({ type: 'error', message: 'Reconnecting... 1/5' });
    const file = writeImage(path.join(home, 'generated_images', threadId));
    say(file);
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    break;
  }
  default: {
    const file = writeImage(path.join(home, 'generated_images', threadId));
    breakTargets();
    say(file);
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
}
