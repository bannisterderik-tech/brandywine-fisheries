#!/usr/bin/env node
/* Local audit. Fails loudly rather than warning quietly — a build that does not
 * pass this does not ship. */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    if (['.git', 'node_modules', 'gen', 'data', 'assets'].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e === 'index.html') pages.push(p);
  }
})(ROOT);

const url = p => '/' + relative(ROOT, dirname(p)).split('\\').join('/') + (relative(ROOT, dirname(p)) ? '/' : '');
const err = [], warn = [];
const titles = new Map(), descs = new Map(), canons = new Set();
const internalLinks = new Set(), pageUrls = new Set();

for (const p of pages) {
  const h = readFileSync(p, 'utf8');
  const u = url(p);
  pageUrls.add(u);
  /* measure the rendered title, not the escaped source — "&amp;" is one
   * character on a results page, not five */
  const unent = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const t = unent((h.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  const d = (h.match(/name="description" content="([^"]*)"/) || [])[1] || '';
  const c = (h.match(/rel="canonical" href="([^"]*)"/) || [])[1] || '';
  const h1s = h.match(/<h1[^>]*>/g) || [];

  if (!t) err.push(`${u} missing title`);
  else if (t.length > 62) warn.push(`${u} title ${t.length} chars: ${t}`);
  if (!d) err.push(`${u} missing description`);
  else if (d.length > 165) warn.push(`${u} description ${d.length} chars`);
  if (!c) err.push(`${u} missing canonical`);
  if (canons.has(c)) err.push(`${u} duplicate canonical ${c}`);
  canons.add(c);
  if (h1s.length !== 1) err.push(`${u} has ${h1s.length} h1 tags`);

  if (titles.has(t)) err.push(`DUPLICATE TITLE: ${u} and ${titles.get(t)} — "${t}"`);
  else titles.set(t, u);
  if (descs.has(d)) err.push(`DUPLICATE DESC: ${u} and ${descs.get(d)}`);
  else descs.set(d, u);

  /* every img needs a non-empty alt, except the decorative logo */
  for (const tag of h.match(/<img[^>]*>/g) || []) {
    const alt = (tag.match(/alt="([^"]*)"/) || [])[1];
    if (alt === undefined) err.push(`${u} img missing alt attribute`);
    else if (!alt && !tag.includes('logo.png')) err.push(`${u} img empty alt: ${tag.slice(0, 70)}`);
  }

  /* schema must parse */
  for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch (e) { err.push(`${u} INVALID JSON-LD: ${e.message}`); }
  }

  /* collect internal links */
  for (const m of h.matchAll(/href="(\/[^"#?]*)"/g)) internalLinks.add(m[1]);
}

/* broken internal links */
const assetsOk = l => l.startsWith('/assets/') && existsSync(join(ROOT, l.replace(/^\//, '')));
const BASE = '/brandywine-fisheries';
for (const l of internalLinks) {
  const stripped = l.startsWith(BASE) ? l.slice(BASE.length) || '/' : l;
  if (assetsOk(stripped) || stripped.startsWith('/assets/')) {
    if (!existsSync(join(ROOT, stripped.replace(/^\//, '')))) err.push(`MISSING ASSET: ${l}`);
    continue;
  }
  if (!pageUrls.has(stripped)) err.push(`BROKEN LINK: ${l} (resolved ${stripped})`);
}

/* orphans — pages nothing links to */
const linkedStripped = new Set([...internalLinks].map(l => l.startsWith(BASE) ? (l.slice(BASE.length) || '/') : l));
const orphans = [...pageUrls].filter(u => u !== '/' && !linkedStripped.has(u));
for (const o of orphans) err.push(`ORPHAN: ${o} — no internal link points here`);

/* sitemap parity */
const sm = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
const smUrls = new Set([...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname.replace(BASE, '') || '/'));
for (const u of pageUrls) if (!smUrls.has(u)) err.push(`NOT IN SITEMAP: ${u}`);
for (const u of smUrls) if (!pageUrls.has(u)) err.push(`SITEMAP GHOST: ${u} has no file`);

console.log(`\n  pages:        ${pages.length}`);
console.log(`  unique titles:${titles.size}`);
console.log(`  sitemap urls: ${smUrls.size}`);
console.log(`  int. links:   ${internalLinks.size}`);
console.log(`\n  ERRORS: ${err.length}   WARNINGS: ${warn.length}\n`);
for (const e of err.slice(0, 40)) console.log('  ✗ ' + e);
if (err.length > 40) console.log(`  … and ${err.length - 40} more errors`);
for (const w of warn.slice(0, 15)) console.log('  ! ' + w);
if (warn.length > 15) console.log(`  … and ${warn.length - 15} more warnings`);
process.exit(err.length ? 1 : 0);
