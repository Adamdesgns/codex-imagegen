#!/usr/bin/env node
/**
 * codex-imagegen: make one still image with your own ChatGPT account, through
 * the OpenAI Codex CLI's built-in image generation tool. No browser, no API key.
 *
 * Node 18+, zero dependencies, ESM.
 *
 * Usage:
 *   node imagegen.mjs (--prompt "..." | --prompt-file p.txt) --out path/name.png
 *                     [--image ref.png]... [--log path/SOURCES.md] [--codex PATH]
 *                     [--timeout-sec 600] [--use-user-config] [--keep-session]
 *   node imagegen.mjs --doctor
 *
 * stdout: ONE JSON object. stderr: human-readable progress.
 * Exit codes: 0 ok, 1 bad arguments, 2 codex not found, 3 codex failed or not
 * signed in, 4 no image produced, 5 timeout.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({
  OK: 0,
  ARGS: 1,
  NOT_FOUND: 2,
  CODEX_FAILED: 3,
  NO_IMAGE: 4,
  TIMEOUT: 5,
});

export class CliError extends Error {
  /** `extra` is merged into the failure JSON (for example `source`, where a made image is safe). */
  constructor(code, message, hint = '', extra = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
    this.extra = extra;
  }
}

// Node's setTimeout cannot wait longer than 2^31-1 ms; anything bigger fires after 1 ms.
export const MAX_TIMEOUT_SEC = 2147483;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const USAGE = `codex-imagegen: make one still image with your own ChatGPT account via the Codex CLI

Usage:
  node imagegen.mjs (--prompt "..." | --prompt-file p.txt) --out path/name.png [options]
  node imagegen.mjs --doctor

Options:
  --prompt TEXT          The image prompt.
  --prompt-file FILE     Read the image prompt from a text file (UTF-8, or UTF-16 with a BOM).
  --out FILE             Where to save the image. Never overwrites: if the file
                         exists, name-2.png, name-3.png ... is used instead.
  --image FILE           Reference image (repeatable) for the same person/object/style.
  --log FILE             Append a markdown entry (prompt, thread, time) to this file.
  --codex PATH           Codex executable (or a .js/.mjs launcher). Also: env CODEX_BIN.
  --timeout-sec N        Stop Codex after N seconds, 1 to ${MAX_TIMEOUT_SEC} (default 600).
  --use-user-config      Let Codex load your config.toml (default: skipped). This also
                         brings back its MCP servers and tools, which the read-only
                         sandbox does not cover. Use it only if you trust that config.
  --keep-session         Keep the Codex session on disk (default: ephemeral).
  --doctor               Check the Codex install, sign-in, CODEX_HOME and Node.
  --help                 Show this help.

Exit codes: 0 ok, 1 bad arguments, 2 codex not found, 3 codex failed or not
signed in, 4 no image produced, 5 timeout.
`;

const NOT_FOUND_HINT =
  'Install Codex (npm install -g @openai/codex, or the Codex desktop app) and sign in with ChatGPT, ' +
  'or point to it with --codex PATH or the CODEX_BIN environment variable. See the README.';

/** How the user can sign in with the Codex we actually found (a Store or Mac app has no `codex` on PATH). */
export function loginAdvice(found) {
  if (!found || found.source === 'PATH') return 'Run `codex login` and choose Sign in with ChatGPT';
  const app = found.source === 'Microsoft Store app' || found.source === 'Codex.app';
  const runner = /\.(js|mjs|cjs)$/i.test(found.bin) ? 'node ' : '';
  return `Run \`${runner}"${found.bin}" login\` and choose Sign in with ChatGPT${app ? ' (or sign in inside the Codex app)' : ''}`;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '--prompt',
  '--prompt-file',
  '--out',
  '--image',
  '--log',
  '--codex',
  '--timeout-sec',
]);
const BOOL_FLAGS = new Set(['--use-user-config', '--keep-session', '--doctor', '--help', '-h']);

export function parseArgs(argv) {
  const opts = {
    prompt: undefined,
    promptFile: undefined,
    out: undefined,
    images: [],
    log: undefined,
    codex: undefined,
    timeoutSec: 600,
    useUserConfig: false,
    keepSession: false,
    doctor: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let name = raw;
    let value;
    if (raw.startsWith('--') && raw.includes('=')) {
      const eq = raw.indexOf('=');
      name = raw.slice(0, eq);
      value = raw.slice(eq + 1);
    }
    if (BOOL_FLAGS.has(name)) {
      if (value !== undefined) throw new CliError(EXIT.ARGS, `${name} does not take a value`);
      if (name === '--help' || name === '-h') opts.help = true;
      else if (name === '--doctor') opts.doctor = true;
      else if (name === '--use-user-config') opts.useUserConfig = true;
      else if (name === '--keep-session') opts.keepSession = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || VALUE_FLAGS.has(next) || BOOL_FLAGS.has(next)) {
          throw new CliError(EXIT.ARGS, `${name} needs a value`);
        }
        value = next;
        i++;
      }
      if (value === '') throw new CliError(EXIT.ARGS, `${name} needs a non-empty value`);
      switch (name) {
        case '--prompt':
          opts.prompt = value;
          break;
        case '--prompt-file':
          opts.promptFile = value;
          break;
        case '--out':
          opts.out = value;
          break;
        case '--image':
          opts.images.push(value);
          break;
        case '--log':
          opts.log = value;
          break;
        case '--codex':
          opts.codex = value;
          break;
        case '--timeout-sec': {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 1 || n > MAX_TIMEOUT_SEC) {
            throw new CliError(EXIT.ARGS, `--timeout-sec must be a number from 1 to ${MAX_TIMEOUT_SEC}, got "${value}"`);
          }
          opts.timeoutSec = n;
          break;
        }
        default:
          break;
      }
      continue;
    }
    throw new CliError(EXIT.ARGS, `Unknown argument: ${raw}`, 'Run with --help for usage.');
  }
  return opts;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decode a prompt file. UTF-8 (with or without a BOM) and UTF-16 with a BOM (what
 * Windows PowerShell 5.1 writes with `>` or Out-File) are understood. Anything else
 * that contains NUL bytes is refused rather than sent to Codex as garbage.
 */
export function decodePromptBytes(buf, label = 'The prompt file') {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return stripBom(buf.subarray(2).toString('utf16le'));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  if (buf.includes(0)) {
    throw new CliError(
      EXIT.ARGS,
      `${label} is not plain UTF-8 text (it contains NUL bytes, which usually means UTF-16 without a BOM).`,
      'Save the prompt file as UTF-8 and try again.',
    );
  }
  return stripBom(buf.toString('utf8'));
}

/** Validate the generation arguments and load the prompt text. */
export function loadRequest(opts) {
  if (opts.prompt !== undefined && opts.promptFile !== undefined) {
    throw new CliError(EXIT.ARGS, 'Use --prompt or --prompt-file, not both.');
  }
  if (opts.prompt === undefined && opts.promptFile === undefined) {
    throw new CliError(EXIT.ARGS, 'Missing the prompt: pass --prompt "..." or --prompt-file FILE.', 'Run with --help for usage.');
  }
  if (!opts.out) {
    throw new CliError(EXIT.ARGS, 'Missing --out: where should the image be saved?', 'Run with --help for usage.');
  }
  let prompt = opts.prompt;
  if (opts.promptFile !== undefined) {
    const file = path.resolve(opts.promptFile);
    if (!isFile(file)) throw new CliError(EXIT.ARGS, `Prompt file not found: ${file}`);
    prompt = decodePromptBytes(fs.readFileSync(file), `Prompt file ${file}`);
  }
  prompt = stripBom(prompt).trim();
  if (!prompt) throw new CliError(EXIT.ARGS, 'The prompt is empty.');
  // Codex silently ignores a missing --image file, so check here.
  const images = opts.images.map((p) => {
    const abs = path.resolve(p);
    if (!isFile(abs)) {
      throw new CliError(EXIT.ARGS, `Reference image not found: ${abs}`, 'Codex would silently ignore it, so check the path.');
    }
    return abs;
  });
  return { prompt, images, out: path.resolve(opts.out) };
}

// ---------------------------------------------------------------------------
// Finding Codex
// ---------------------------------------------------------------------------

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Equivalent of `where codex` / `which codex`, with codex.exe/.cmd/.bat on Windows.
 * `accept` lets the caller skip a hit it cannot use, so the search carries on.
 */
export function findOnPath(name, env = process.env, platform = process.platform, accept = () => true) {
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(sep)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate) && accept(candidate)) return candidate;
    }
  }
  return null;
}

/** The Microsoft Store Codex app has no `codex` on PATH; its CLI lives inside the package. */
export function findWindowsStoreCodex() {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage OpenAI.Codex).InstallLocation'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true },
  );
  if (r.error || r.status !== 0) return null;
  const locations = String(r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
  for (const loc of locations) {
    const exe = path.join(loc, 'app', 'resources', 'codex.exe');
    if (isFile(exe)) return exe;
  }
  return null;
}

export const MAC_APP_CODEX = '/Applications/Codex.app/Contents/Resources/codex';

const isCmdShim = (p) => /\.(cmd|bat)$/i.test(p);

/**
 * Order: --codex, env CODEX_BIN, `codex` on PATH, Windows Store package,
 * macOS app bundle. A .cmd/.bat on PATH that cannot be traced to the program it
 * starts is skipped, not fatal: the later places are still tried. Throws CliError(2)
 * if none is usable. `storeLookup` and `macApp` can be replaced (the tests do).
 */
export function resolveCodex({
  flag,
  env = process.env,
  platform = process.platform,
  storeLookup = findWindowsStoreCodex,
  macApp = MAC_APP_CODEX,
} = {}) {
  const explicit = flag
    ? { value: flag, source: '--codex' }
    : env.CODEX_BIN
      ? { value: env.CODEX_BIN, source: 'CODEX_BIN' }
      : null;
  if (explicit) {
    const abs = path.resolve(explicit.value);
    if (isFile(abs)) return { bin: abs, source: explicit.source };
    if (!/[\\/]/.test(explicit.value)) {
      const named = findOnPath(explicit.value, env, platform);
      if (named) return { bin: named, source: explicit.source };
    }
    throw new CliError(EXIT.NOT_FOUND, `${explicit.source} points to a file that does not exist: ${abs}`, NOT_FOUND_HINT);
  }
  const untraceable = [];
  const onPath = findOnPath('codex', env, platform, (candidate) => {
    if (!isCmdShim(candidate) || npmShimTarget(candidate)) return true;
    untraceable.push(candidate);
    return false;
  });
  if (onPath) return { bin: onPath, source: 'PATH' };
  if (platform === 'win32') {
    const store = storeLookup();
    if (store) return { bin: store, source: 'Microsoft Store app' };
  }
  if (platform === 'darwin' && isFile(macApp)) {
    return { bin: macApp, source: 'Codex.app' };
  }
  if (untraceable.length) {
    throw new CliError(
      EXIT.NOT_FOUND,
      `Found ${untraceable[0]} on PATH but could not work out which program it starts.`,
      'Point --codex (or CODEX_BIN) at the real codex.exe, or at node_modules/@openai/codex/bin/codex.js.',
    );
  }
  throw new CliError(EXIT.NOT_FOUND, 'Could not find the Codex CLI.', NOT_FOUND_HINT);
}

/**
 * The program a codex.cmd shim starts (a .js file), or null. npm's newer shims write
 * "%dp0%\...\codex.js"; pnpm and older npm/Yarn write "%~dp0\...\codex.js", and pnpm
 * keeps the package somewhere else (PNPM_HOME\global\5\node_modules), so the path in
 * the shim is the only reliable source. The default npm layout is the last guess.
 */
export function npmShimTarget(cmdPath) {
  const dir = path.dirname(cmdPath);
  let text = '';
  try {
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    /* fall through to the default npm layout */
  }
  const candidates = [];
  for (const m of text.matchAll(/%~?dp0%?[\\/]+([^"\r\n%]+?\.[cm]?js)(?=["\s]|$)/gi)) {
    candidates.push(path.join(dir, ...m[1].split(/[\\/]+/)));
  }
  candidates.push(path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  return candidates.find(isFile) ?? null;
}

/**
 * How to start a codex path WITHOUT a shell (shell:true is how quoting bugs and
 * injection happen). .js/.mjs/.cjs run under this Node; an npm .cmd shim is
 * resolved to the .js it launches; anything else (codex.exe, a Unix binary) runs as is.
 */
export function launcherFor(bin) {
  const ext = path.extname(bin).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, prefix: [bin] };
  }
  if (ext === '.cmd' || ext === '.bat') {
    const js = npmShimTarget(bin);
    if (js) return { command: process.execPath, prefix: [js] };
    throw new CliError(
      EXIT.NOT_FOUND,
      `Found ${bin} but could not work out which program it starts.`,
      'Point --codex (or CODEX_BIN) at the real codex.exe, or at node_modules/@openai/codex/bin/codex.js.',
    );
  }
  return { command: bin, prefix: [] };
}

function runSync(launcher, args, timeoutMs, env) {
  const r = spawnSync(launcher.command, [...launcher.prefix, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env,
  });
  if (r.error && r.error.code !== 'ETIMEDOUT') {
    throw new CliError(EXIT.NOT_FOUND, `Codex was found but could not be started: ${r.error.message}`, NOT_FOUND_HINT);
  }
  return r;
}

export function getCodexVersion(launcher, env) {
  const r = runSync(launcher, ['--version'], 30000, env);
  const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  const m = text.match(/(\d+\.\d+\.\d+[^\s]*)/);
  return m ? m[1] : text.split(/\r?\n/)[0] || 'unknown';
}

export function codexHomeDir(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

/**
 * The environment Codex is started with. A relative CODEX_HOME would mean two
 * different folders (Codex runs in a temp dir, this script in the caller's), so it is
 * made absolute. When CODEX_HOME is not set, Codex is left to find its own default.
 */
export function codexChildEnv(env = process.env) {
  return env.CODEX_HOME ? { ...env, CODEX_HOME: codexHomeDir(env) } : env;
}

// ---------------------------------------------------------------------------
// The task text and the codex command line
// ---------------------------------------------------------------------------

export function buildTask(prompt, refCount = 0) {
  let task =
    'Use your built-in image generation tool exactly once to generate this image. ' +
    'Do not run shell commands and do not edit any files. ' +
    'When it is done, reply with only the full file path of the saved image.';
  if (refCount > 0) {
    task +=
      refCount === 1
        ? '\nUse the attached image as the visual reference for the same person, object and style.'
        : '\nUse the attached images as the visual reference for the same person, object and style.';
  }
  return `${task}\n\nIMAGE PROMPT:\n${prompt}`;
}

/**
 * Codex features switched off for an image run. `-s read-only` only limits what a
 * command can WRITE; with the shell tool on, a command could still read any file on
 * the disk. An image run needs none of these, so they are turned off:
 *   shell_tool    the command tool (it also gates exec_command / write_stdin)
 *   computer_use, browser_use   drive the desktop and a browser
 *   apps, plugins   connectors and bundles that run outside the command sandbox
 *   multi_agent   spawning helper agents
 * The `-c features.NAME=false` form is used, not `--disable NAME`, because Codex
 * rejects `--disable` with an unknown name (an older or newer Codex would then fail
 * outright) while `-c` quietly ignores a name it does not know.
 */
export const DISABLED_FEATURES = Object.freeze(['shell_tool', 'computer_use', 'browser_use', 'apps', 'plugins', 'multi_agent']);

/**
 * How a reference image is named on the Codex command line. Codex's --image splits
 * its value on commas, so a path with a comma would reach it as two missing files
 * and be dropped without an error. The copy's absolute path is used unless that has a
 * comma too (a comma in the temp dir); then the bare file name is used, which works
 * because Codex runs with the scratch dir as its working directory.
 */
export function referenceArg(scratch, name) {
  const abs = path.join(scratch, name);
  return abs.includes(',') ? name : abs;
}

/** Copy each reference image into the scratch dir as ref-1.png, ref-2.jpg ... and return the command-line values. */
export function stageReferences(images, scratch) {
  return images.map((src, i) => {
    const ext = path.extname(src).toLowerCase();
    const name = `ref-${i + 1}${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ''}`;
    try {
      fs.copyFileSync(src, path.join(scratch, name));
    } catch (err) {
      throw new CliError(EXIT.ARGS, `Could not read the reference image ${src}: ${err.message}`);
    }
    return referenceArg(scratch, name);
  });
}

export function buildCodexArgs({ scratch, lastMessageFile, images = [], useUserConfig = false, keepSession = false }) {
  const args = ['exec', '--skip-git-repo-check'];
  if (!useUserConfig) args.push('--ignore-user-config');
  if (!keepSession) args.push('--ephemeral');
  args.push('--json', '-s', 'read-only');
  for (const feature of DISABLED_FEATURES) args.push('-c', `features.${feature}=false`);
  args.push('-C', scratch, '-o', lastMessageFile);
  // `--image` is variadic in the Codex CLI. The --image=FILE form takes exactly one
  // value, so it can never swallow another argument (checked against codex-cli 0.159.2),
  // and it goes last. `images` are already comma-free (see referenceArg).
  for (const img of images) args.push(`--image=${img}`);
  return args;
}

// ---------------------------------------------------------------------------
// Running codex
// ---------------------------------------------------------------------------

let activeChild = null;
let activeScratch = null;

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    // child.kill() would leave anything Codex started behind.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* not a group leader */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

function info(message) {
  process.stderr.write(`codex-imagegen: ${message}\n`);
}

function runCodex(launcher, args, { input, cwd, env, timeoutMs, onLine }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(launcher.command, [...launcher.prefix, ...args], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ spawnError: err, stdout: '', stderr: '', code: null, timedOut: false });
      return;
    }
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let settled = false;
    let hardStop = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      activeChild = null;
      resolve({ stdout, stderr, timedOut, ...result });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // If the process never reports closing, do not wait forever.
      hardStop = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 5000);
    }, timeoutMs);

    // setEncoding uses a decoder that holds back half of a multi-byte character until
    // the rest arrives; decoding chunk by chunk would turn it into replacement characters.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      stdout += text;
      pending += text;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (onLine) onLine(line);
      }
    });
    child.stderr.on('data', (text) => {
      stderr += text;
    });
    child.stdin.on('error', () => {
      /* codex may exit before reading all of stdin */
    });
    child.on('error', (err) => finish({ spawnError: err, code: null, signal: null }));
    child.on('close', (code, signal) => {
      if (pending && onLine) onLine(pending);
      finish({ code, signal });
    });
    child.stdin.end(input, 'utf8');
  });
}

/** Parse `codex exec --json` output (JSONL). Tolerates a BOM and non-JSON lines. */
export function parseCodexOutput(text) {
  const result = {
    threadId: null,
    messages: [],
    errors: [],
    warnings: [],
    turnCompleted: false,
    turnFailed: false,
    events: 0,
  };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripBom(rawLine).trim();
    if (!line || line[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    result.events++;
    switch (ev.type) {
      case 'thread.started':
        if (typeof ev.thread_id === 'string') result.threadId = ev.thread_id;
        break;
      case 'item.completed': {
        const item = ev.item || {};
        if (item.type === 'agent_message' && typeof item.text === 'string') result.messages.push(item.text);
        else if (item.type === 'error' && typeof item.message === 'string') result.warnings.push(item.message);
        break;
      }
      case 'turn.completed':
        result.turnCompleted = true;
        break;
      case 'turn.failed':
        result.turnFailed = true;
        result.errors.push(errorText(ev));
        break;
      case 'error':
        result.errors.push(errorText(ev));
        break;
      default:
        break;
    }
  }
  // An `error` event can be a retry notice followed by a normal finish, so it only
  // counts as a failure when the turn never completed.
  result.failed = result.turnFailed || (result.errors.length > 0 && !result.turnCompleted);
  return result;
}

function errorText(ev) {
  if (typeof ev.message === 'string') return ev.message;
  if (ev.error && typeof ev.error.message === 'string') return ev.error.message;
  if (typeof ev.error === 'string') return ev.error;
  return JSON.stringify(ev);
}

const AUTH_PATTERN =
  /(not (?:logged|signed) in|log ?in|sign ?in|unauthori[sz]ed|\b401\b|\b403\b|authenticat|token (?:expired|invalid)|refresh token|api key)/i;

// ---------------------------------------------------------------------------
// Finding and saving the image
// ---------------------------------------------------------------------------

function newestImageIn(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    if (!IMAGE_EXTS.has(path.extname(name).toLowerCase())) continue;
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    if (!best || st.mtimeMs > best.mtimeMs || (st.mtimeMs === best.mtimeMs && name > path.basename(best.file))) {
      best = { file, mtimeMs: st.mtimeMs };
    }
  }
  return best ? best.file : null;
}

/** Image file paths that appear in a piece of text (Windows and POSIX styles). */
export function extractImagePaths(text) {
  const found = [];
  const add = (p) => {
    const cleaned = p.trim();
    if (cleaned && !found.includes(cleaned)) found.push(cleaned);
  };
  const patterns = [
    /[A-Za-z]:[\\/][^\r\n"'`<>|*?]*?\.(?:png|jpe?g|webp)\b/gi,
    /[A-Za-z]:[\\/][^\s"'`<>|*?]*?\.(?:png|jpe?g|webp)\b/gi,
    /(?:^|[\s"'`(])(\/[^\r\n"'`<>|*?]*?\.(?:png|jpe?g|webp))\b/gi,
    /(?:^|[\s"'`(])(\/[^\s"'`<>|*?]*?\.(?:png|jpe?g|webp))\b/gi,
  ];
  for (const re of patterns) {
    for (const m of String(text).matchAll(re)) add(m[1] ?? m[0]);
  }
  return found;
}

/**
 * Trust the file on disk, not the message: first the newest image in
 * <CODEX_HOME>/generated_images/<thread_id>/, then a path named in the final
 * message (only if that file was written during this run).
 */
export function findGeneratedImage({ codexHome, threadId, lastMessage, startedAt }) {
  if (threadId && /^[\w.-]+$/.test(threadId) && threadId !== '.' && threadId !== '..') {
    const file = newestImageIn(path.join(codexHome, 'generated_images', threadId));
    if (file) return { file, via: 'thread folder' };
  }
  for (const candidate of extractImagePaths(lastMessage || '')) {
    if (!IMAGE_EXTS.has(path.extname(candidate).toLowerCase())) continue;
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0 && st.mtimeMs >= startedAt - 2000) {
        return { file: candidate, via: 'path in message' };
      }
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** 'png' | 'jpeg' | 'webp' | null, from the file's first bytes. */
export function sniffImageType(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Real pixel size from the file header: PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X. */
export function imageSize(buf) {
  const type = sniffImageType(buf);
  try {
    if (type === 'png') {
      if (buf.length < 24) return null;
      return { type, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (type === 'jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        if (marker === 0xd9 || marker === 0xda) return null;
        const len = buf.readUInt16BE(i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { type, height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
      return null;
    }
    if (type === 'webp') {
      const fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8X') {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { type, width, height };
      }
      if (fourcc === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { type, width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      if (fourcc === 'VP8 ') {
        return { type, width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extFamily(ext) {
  const e = ext.toLowerCase();
  return e === '.jpeg' || e === '.jpg' ? '.jpg' : e;
}

const TYPE_EXT = { png: '.png', jpeg: '.jpg', webp: '.webp' };

/**
 * Where to save: --out as given, unless its image extension contradicts the real
 * format (then the real one is used) or it has none (then it is added). A dot that
 * is not an image extension, like "name.v2", is kept as part of the name.
 */
export function chooseDestination(outPath, sourceFile, buf) {
  const sniffed = sniffImageType(buf);
  const sourceExt = path.extname(sourceFile).toLowerCase();
  const real = sniffed ? (extFamily(sourceExt) === TYPE_EXT[sniffed] ? sourceExt : TYPE_EXT[sniffed]) : sourceExt || '.png';
  const wanted = path.extname(outPath);
  if (IMAGE_EXTS.has(wanted.toLowerCase())) {
    return extFamily(wanted) === extFamily(real) ? outPath : outPath.slice(0, -wanted.length) + real;
  }
  return outPath + real;
}

/** Copy src to dest without ever overwriting: name.png, name-2.png, name-3.png ... */
export function copyWithoutOverwrite(src, dest) {
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const stem = path.basename(dest, ext);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 100000; n++) {
    const candidate = n === 1 ? dest : path.join(dir, `${stem}-${n}${ext}`);
    try {
      fs.copyFileSync(src, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`Could not find a free file name next to ${dest}`);
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

function longestBacktickRun(text) {
  let longest = 0;
  for (const m of String(text).matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return longest;
}

export function formatLogEntry({ when, fileName, width, height, codexVersion, threadId, refs, seconds, prompt }) {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(prompt) + 1));
  const size = width && height ? ` (${width}x${height})` : '';
  return [
    `## ${when.toISOString()} - ${fileName}`,
    '',
    `- File: ${fileName}${size}`,
    `- Codex: ${codexVersion}`,
    `- Thread: ${threadId || 'unknown'}`,
    `- Reference images: ${refs.length ? refs.join(', ') : 'none'}`,
    `- Seconds: ${seconds}`,
    '',
    'Prompt:',
    '',
    `${fence}text`,
    prompt,
    fence,
    '',
    '',
  ].join('\n');
}

/** Append only. Earlier entries are never rewritten. */
export function appendLog(logFile, entry) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  let prefix = '';
  try {
    const st = fs.statSync(logFile);
    if (st.size === 0) {
      prefix = '# Image generation log\n\n';
    } else {
      const fd = fs.openSync(logFile, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, st.size - 1);
        if (last[0] !== 0x0a) prefix = '\n\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    prefix = '# Image generation log\n\n';
  }
  fs.appendFileSync(logFile, prefix + entry, 'utf8');
}

function refLabel(ref, logFile) {
  const rel = path.relative(path.dirname(path.resolve(logFile)), ref);
  const label = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(ref);
  return label.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// The generation flow
// ---------------------------------------------------------------------------

function tail(text, max = 2000) {
  const t = String(text || '').trim();
  return t.length > max ? `...${t.slice(-max)}` : t;
}

/**
 * Fail early (exit 1) if `folder` cannot be written to, BEFORE a generation is spent.
 * Finds the nearest folder that exists and really writes (then removes) a probe file
 * there, so nothing is created when the check passes.
 */
export function assertFolderWritable(folder, what) {
  let cur = path.resolve(folder);
  for (;;) {
    let st = null;
    try {
      st = fs.statSync(cur);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        throw new CliError(EXIT.ARGS, `${what}: cannot look at ${cur} (${err.code || err.message}).`);
      }
    }
    if (st) {
      if (!st.isDirectory()) throw new CliError(EXIT.ARGS, `${what}: ${cur} is a file, not a folder.`, 'Choose a path inside a folder.');
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const probe = path.join(cur, `.codex-imagegen-write-test-${process.pid}-${Date.now()}`);
  try {
    fs.closeSync(fs.openSync(probe, 'wx'));
    fs.unlinkSync(probe);
  } catch (err) {
    throw new CliError(EXIT.ARGS, `${what}: cannot write in ${cur} (${err.code || err.message}).`, 'Choose a folder you can write to.');
  }
}

/** Check --out and --log up front. A made image must never be lost to a bad path. */
export function preflightTargets({ out, log }) {
  assertFolderWritable(path.dirname(out), '--out');
  if (log) {
    const logFile = path.resolve(log);
    let st = null;
    try {
      st = fs.statSync(logFile);
    } catch {
      /* does not exist yet: the folder check below covers creating it */
    }
    if (st) {
      if (st.isDirectory()) throw new CliError(EXIT.ARGS, `--log: ${logFile} is a folder, not a file.`, 'Give --log a file name such as images/SOURCES.md.');
      try {
        fs.closeSync(fs.openSync(logFile, 'a'));
      } catch (err) {
        throw new CliError(EXIT.ARGS, `--log: cannot write to ${logFile} (${err.code || err.message}).`);
      }
    } else {
      assertFolderWritable(path.dirname(logFile), '--log');
    }
  }
}

export async function generate(opts, env = process.env) {
  const { prompt, images, out } = loadRequest(opts);
  preflightTargets({ out, log: opts.log });
  const found = resolveCodex({ flag: opts.codex, env });
  const launcher = launcherFor(found.bin);
  const codexEnv = codexChildEnv(env);
  const codexVersion = getCodexVersion(launcher, codexEnv);
  const codexHome = codexHomeDir(env);
  info(`using Codex ${codexVersion} (${found.source}: ${found.bin})`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-imagegen-'));
  activeScratch = scratch;
  try {
    const lastMessageFile = path.join(scratch, 'last-message.txt');
    const args = buildCodexArgs({
      scratch,
      lastMessageFile,
      images: stageReferences(images, scratch),
      useUserConfig: opts.useUserConfig,
      keepSession: opts.keepSession,
    });
    const startedAt = Date.now();
    info(`generating (up to ${opts.timeoutSec}s)${images.length ? ` with ${images.length} reference image(s)` : ''}...`);
    const heartbeat = setInterval(() => {
      info(`still working... ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }, 20000);
    let run;
    try {
      run = await runCodex(launcher, args, {
        input: buildTask(prompt, images.length),
        cwd: scratch,
        env: codexEnv,
        timeoutMs: Math.round(opts.timeoutSec * 1000),
        onLine: (line) => {
          const t = stripBom(line).trim();
          if (t.startsWith('{') && t.includes('"thread.started"')) info('Codex session started');
        },
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (run.spawnError) {
      throw new CliError(EXIT.NOT_FOUND, `Codex could not be started: ${run.spawnError.message}`, NOT_FOUND_HINT);
    }
    if (run.timedOut) {
      throw new CliError(
        EXIT.TIMEOUT,
        `Timed out after ${opts.timeoutSec} seconds. Codex was stopped.`,
        'Try again, or raise --timeout-sec. A busy service can take several minutes.',
      );
    }

    const parsed = parseCodexOutput(run.stdout);
    let lastMessage = '';
    try {
      lastMessage = stripBom(fs.readFileSync(lastMessageFile, 'utf8')).trim();
    } catch {
      /* the file is only written on a normal finish */
    }
    if (!lastMessage && parsed.messages.length) lastMessage = parsed.messages[parsed.messages.length - 1].trim();

    if (run.code !== 0 || parsed.failed) {
      const detail = [...parsed.errors, run.stderr.trim() && `stderr: ${tail(run.stderr)}`]
        .filter(Boolean)
        .join('\n');
      const text = detail || lastMessage || 'Codex exited without saying why.';
      const authLike = AUTH_PATTERN.test(`${detail}\n${lastMessage}`);
      throw new CliError(
        EXIT.CODEX_FAILED,
        `Codex failed${run.code ? ` (exit code ${run.code})` : ''}: ${tail(text)}`,
        authLike
          ? `You may not be signed in. ${loginAdvice(found)}, then try again. \`--doctor\` shows the sign-in status.`
          : `Run with --doctor to check the Codex install and sign-in. If the error mentions a usage or rate limit, wait and try again later. If you are signed out: ${loginAdvice(found)}.`,
      );
    }

    const image = findGeneratedImage({ codexHome, threadId: parsed.threadId, lastMessage, startedAt });
    if (!image) {
      throw new CliError(
        EXIT.NO_IMAGE,
        `Codex finished but no image was produced. Codex said: ${lastMessage || '(no message)'}`,
        'Codex may have refused the prompt (for example under a content policy): read its message, change one thing in the prompt, and try again rather than retrying unchanged. ' +
          'If it says it cannot generate images, changing the prompt will not help: update Codex (npm install -g @openai/codex) and check that your ChatGPT plan includes Codex image generation.',
      );
    }

    // The image exists now. From here on, a failure must never hide where it is.
    let buf;
    let dest;
    let saved;
    try {
      buf = fs.readFileSync(image.file);
      dest = chooseDestination(out, image.file, buf);
      saved = copyWithoutOverwrite(image.file, dest);
    } catch (err) {
      throw new CliError(
        EXIT.ARGS,
        `Codex made the image but it could not be saved to ${out}: ${err.message}`,
        `The image is safe at ${image.file}. Copy it from there. Do not run again: that spends another generation.`,
        { source: image.file },
      );
    }
    const size = imageSize(buf);
    if (!size) info('could not read the image size from the file header');
    const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
    if (path.resolve(saved) !== dest) info(`${path.basename(dest)} already existed, saved as ${path.basename(saved)}`);

    let logError = null;
    if (opts.log) {
      const logFile = path.resolve(opts.log);
      try {
        appendLog(
          logFile,
          formatLogEntry({
            when: new Date(),
            fileName: path.basename(saved),
            width: size && size.width,
            height: size && size.height,
            codexVersion,
            threadId: parsed.threadId,
            refs: images.map((r) => refLabel(r, logFile)),
            seconds,
            prompt,
          }),
        );
      } catch (err) {
        logError = `Could not write the log ${logFile}: ${err.message}`;
        info(`warning: ${logError} (the image itself was saved)`);
      }
    }

    return {
      ok: true,
      out: saved,
      width: size ? size.width : null,
      height: size ? size.height : null,
      seconds,
      thread_id: parsed.threadId,
      codex_version: codexVersion,
      source: image.file,
      ...(logError ? { log_error: logError } : {}),
    };
  } finally {
    activeScratch = null;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// --doctor
// ---------------------------------------------------------------------------

export function doctor(opts, env = process.env) {
  const out = [];
  const say = (line) => out.push(line);
  say(`Node:        ${process.version} (${process.platform} ${process.arch})${Number(process.versions.node.split('.')[0]) < 18 ? '  TOO OLD, need 18+' : ''}`);
  const home = codexHomeDir(env);
  say(`CODEX_HOME:  ${home}${fs.existsSync(home) ? '' : '  (does not exist yet)'}`);
  let code = EXIT.OK;
  try {
    const found = resolveCodex({ flag: opts.codex, env });
    const launcher = launcherFor(found.bin);
    const codexEnv = codexChildEnv(env);
    say(`Codex:       ${found.bin}  (${found.source})`);
    say(`Version:     ${getCodexVersion(launcher, codexEnv)}`);
    const r = runSync(launcher, ['login', 'status'], 30000, codexEnv);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).join(' / ');
    if (r.status === 0) {
      say(`Login:       ${text || 'signed in'}`);
    } else if (/unrecogni[sz]ed|unknown|unexpected argument/i.test(text)) {
      say('Login:       unknown (this Codex has no `login status`; the first image run will tell)');
    } else {
      say(`Login:       NOT SIGNED IN - ${text || 'no details'}`);
      say(`             ${loginAdvice(found)}.`);
      code = EXIT.CODEX_FAILED;
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    say(`Codex:       NOT FOUND - ${err.message}`);
    if (err.hint) say(`             ${err.hint}`);
    code = err.code;
  }
  say(`Usable:      ${code === EXIT.OK ? 'yes' : 'no'}`);
  return { code, text: out.join('\n') };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function emit(code, object, humanText) {
  if (humanText) process.stderr.write(`${humanText}\n`);
  process.stdout.write(`${JSON.stringify(object)}\n`, () => process.exit(code));
}

function emitFailure(err) {
  const code = err instanceof CliError ? err.code : EXIT.CODEX_FAILED;
  const message = err instanceof CliError ? err.message : `Unexpected error: ${err && err.stack ? err.stack : err}`;
  const hint =
    err instanceof CliError
      ? err.hint
      : 'This looks like a bug in codex-imagegen, not a sign-in problem. Do not run `codex login`; please report it.';
  const extra = err instanceof CliError ? err.extra : {};
  emit(code, { ok: false, code, error: message, hint, ...extra }, `codex-imagegen: ${message}${hint ? `\n  hint: ${hint}` : ''}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try {
    if (argv.length === 0) throw new CliError(EXIT.ARGS, 'No arguments given.', 'Run with --help for usage.');
    opts = parseArgs(argv);
  } catch (err) {
    return emitFailure(err);
  }
  if (opts.help) {
    process.stdout.write(USAGE, () => process.exit(EXIT.OK));
    return undefined;
  }
  const onSignal = () => {
    killTree(activeChild);
    if (activeScratch) fs.rmSync(activeScratch, { recursive: true, force: true });
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    if (opts.doctor) {
      const { code, text } = doctor(opts, env);
      process.stdout.write(`${text}\n`, () => process.exit(code));
      return undefined;
    }
    const result = await generate(opts, env);
    return emit(EXIT.OK, result, `codex-imagegen: saved ${result.out} (${result.width}x${result.height}, ${result.seconds}s)`);
  } catch (err) {
    return emitFailure(err);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
