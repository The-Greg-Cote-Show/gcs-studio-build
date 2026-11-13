#!/usr/bin/env node
// Makes three new private links (Greg, Chris, Yeti).
//
//   node scripts/make-links.mjs [board address] [output folder]
//
// Writes two files OUTSIDE the repo by default (the folder that holds it):
//   seed.sql                              hashes only, paste into the D1 Console
//   PRIVATE_LINKS_DELETE_AFTER_SAVING.txt the three links, shown nowhere else
//
// Nothing secret is printed to the screen. Running it again makes brand new
// links and the old ones die as soon as the new seed.sql is run.

import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const base = (process.argv[2] || 'https://the-greg-cote-show.github.io/gcs-studio-build/').replace(/\/?$/, '/');
const outDir = resolve(process.argv[3] || resolve(repoRoot, '..'));

if (outDir === repoRoot || outDir.startsWith(repoRoot + '\\') || outDir.startsWith(repoRoot + '/')) {
  console.error('Pick an output folder outside the repo so the links never get uploaded.');
  process.exit(1);
}

const people = [
  { id: 1, name: 'Greg', role: 'member' },
  { id: 2, name: 'Chris', role: 'member' },
  { id: 3, name: 'Yeti', role: 'admin' },
];

const now = Date.now();
const sql = [
  '-- GCS Studio Build: people. Hashes only, no keys.',
  '-- Paste into the D1 Console and press Execute. Do NOT upload this file to GitHub.',
  '-- Running it again replaces the hashes, so any older links stop working.',
  '',
];
const links = [
  'GCS Studio Build: private links',
  '',
  'Save each link somewhere safe (a password manager or a private note), send Greg and Chris theirs,',
  'then DELETE THIS FILE. These links are not stored anywhere else.',
  '',
];

for (const p of people) {
  const key = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(key).digest('hex');
  sql.push(
    `INSERT INTO people (id, name, role, key_hash, created_at) VALUES (${p.id}, '${p.name}', '${p.role}', '${hash}', ${now})\n` +
      `  ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, key_hash = excluded.key_hash, revoked_at = NULL;`
  );
  links.push(`${p.name}${p.role === 'admin' ? ' (admin)' : ''}:`, `${base}#k=${key}`, '');
}

const seedPath = join(outDir, 'seed.sql');
const linksPath = join(outDir, 'PRIVATE_LINKS_DELETE_AFTER_SAVING.txt');
writeFileSync(seedPath, sql.join('\n') + '\n');
writeFileSync(linksPath, links.join('\n'));

console.log('Done. Wrote:');
console.log('  ' + seedPath);
console.log('  ' + linksPath);
console.log('The links are only in that second file.');
