// Checks on the repo itself: manifests agree, the skill is short, nothing personal is shipped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

test('plugin.json and marketplace.json agree and point at the skill', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'codex-imagegen');
  assert.equal(plugin.version, market.plugins[0].version);
  assert.equal(plugin.version, market.metadata.version);
  assert.equal(plugin.name, market.plugins[0].name);
  assert.equal(market.plugins[0].source, './');
  assert.equal(plugin.license, 'MIT');
  assert.deepEqual(plugin.author, { name: 'Adamdesgns' });
  for (const rel of plugin.skills) {
    assert.ok(fs.existsSync(path.join(root, rel, 'SKILL.md')), `${rel}/SKILL.md exists`);
  }
  assert.equal(readJson('package.json').version, plugin.version);
});

test('SKILL.md has the right frontmatter and stays short', () => {
  const text = fs.readFileSync(path.join(root, 'skills', 'codex-imagegen', 'SKILL.md'), 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, 'has frontmatter');
  assert.match(fm[1], /^name: codex-imagegen$/m);
  assert.match(fm[1], /^description: .{80,}/m);
  assert.ok(text.split(/\r?\n/).length <= 120, 'under about 120 lines');
  assert.match(text, /scripts\/imagegen\.mjs/);
});

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', '.scratch', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('no build-machine paths or home directory are shipped', () => {
  const home = os.homedir();
  const needles = [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')].filter((n) => n.length > 4);
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of needles) {
      assert.ok(!text.includes(needle), `${path.relative(root, file)} contains "${needle}"`);
    }
  }
});

test('no email addresses are shipped (the only personal detail allowed is the Adamdesgns handle)', () => {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  for (const file of walk(root)) {
    const found = fs.readFileSync(file, 'utf8').match(email) || [];
    assert.deepEqual(found, [], `${path.relative(root, file)} contains an email address`);
  }
});

test('the plugin has no runtime dependencies', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
