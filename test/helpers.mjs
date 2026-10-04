// Shared test helpers: tiny image builders and a CLI runner.
// (node --test may also run this file directly; it has no side effects.)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.join(here, '..', 'skills', 'codex-imagegen', 'scripts', 'imagegen.mjs');
export const STUB = path.join(here, 'stub-codex.mjs');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable solid-colour PNG. */
export function makePng(width, height, [r, g, b] = [30, 90, 200]) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** JPEG headers only (APP0 + SOF0 + EOI): enough to test size reading, not decodable. */
export function makeJpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  sof.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 10);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** WebP headers only. kind: 'VP8X' | 'VP8L' | 'VP8 '. */
export function makeWebp(kind, width, height) {
  const payload = Buffer.alloc(16);
  if (kind === 'VP8X') {
    payload.writeUIntLE(width - 1, 4, 3);
    payload.writeUIntLE(height - 1, 7, 3);
  } else if (kind === 'VP8L') {
    payload[0] = 0x2f;
    payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  } else {
    payload.set([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a], 0);
    payload.writeUInt16LE(width, 6);
    payload.writeUInt16LE(height, 8);
  }
  const chunk = Buffer.concat([Buffer.from(kind, 'latin1'), Buffer.from([payload.length, 0, 0, 0]), payload]);
  const header = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
  header.writeUInt32LE(chunk.length + 4, 4);
  return Buffer.concat([header, chunk]);
}

export function tempDir(prefix = 'cxig-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run imagegen.mjs as a subprocess against the stub Codex and a throwaway CODEX_HOME.
 * Returns { status, stdout, stderr, json, home, record }.
 */
export function runCli(args, { env = {}, home = tempDir('cxig-home-'), withStub = true, timeout = 60000, cwd } = {}) {
  const record = path.join(home, 'stub-record.jsonl');
  const fullEnv = {
    ...process.env,
    CODEX_HOME: home,
    STUB_RECORD: record,
    ...(withStub ? { CODEX_BIN: STUB } : {}),
    ...env,
  };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: fullEnv, encoding: 'utf8', timeout, cwd });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '');
  } catch {
    /* not JSON (help, doctor) */
  }
  const recorded = fs.existsSync(record)
    ? fs
        .readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, home, record: recorded };
}
