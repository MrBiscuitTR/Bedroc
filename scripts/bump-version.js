#!/usr/bin/env node
// bump-version.js — bump the app version across all relevant files.
//
// Usage (from repo root):
//   node scripts/bump-version.js 1.0.14
//   npm run bump-version --prefix bedroc -- 1.0.14
//
// Files updated:
//   bedroc/package.json          — frontend npm package version
//   bedroc/static/sw.js          — service worker CACHE_NAME (bedroc-v<VERSION>)
//   desktop/package.json         — electron app version (controls installer/build filenames)
//   server/package.json          — backend npm package version

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = resolve(__dir, '..');

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.js <major.minor.patch>');
  process.exit(1);
}

function bumpJson(relPath, transform) {
  const abs  = resolve(root, relPath);
  const json = JSON.parse(readFileSync(abs, 'utf8'));
  const old  = json.version;
  transform(json);
  writeFileSync(abs, JSON.stringify(json, null, '\t') + '\n');
  console.log(`  ${relPath}: ${old} → ${json.version}`);
}

function bumpText(relPath, pattern, replacement) {
  const abs  = resolve(root, relPath);
  const src  = readFileSync(abs, 'utf8');
  const matches = [...src.matchAll(pattern)].map(m => m[0]);
  if (matches.length === 0) {
    console.warn(`  WARNING: no match in ${relPath} — check the pattern`);
    return;
  }
  const next = src.replace(pattern, replacement);
  writeFileSync(abs, next);
  const afters = [...next.matchAll(pattern)].map(m => m[0]);
  matches.forEach((before, i) => console.log(`  ${relPath}: "${before}" → "${afters[i] ?? '?'}"`));
}

console.log(`\nBumping version to ${newVersion}...\n`);

// bedroc/package.json
bumpJson('bedroc/package.json', j => { j.version = newVersion; });

// desktop/package.json
bumpJson('desktop/package.json', j => { j.version = newVersion; });

// server/package.json
bumpJson('server/package.json', j => { j.version = newVersion; });

// bedroc/static/sw.js — update CACHE_NAME and SHELL_CACHE constants
bumpText(
  'bedroc/static/sw.js',
  /bedroc-(?:shell-)?v[\d.]+/g,
  (match) => match.replace(/[\d.]+$/, newVersion),
);

console.log('\nDone.\n');
