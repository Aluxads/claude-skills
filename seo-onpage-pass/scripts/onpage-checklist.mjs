#!/usr/bin/env node
/**
 * onpage-checklist.mjs
 * Runs the 7-dimension onpage SEO checklist against a page for a target keyword.
 * Usage: node scripts/onpage-checklist.mjs <html-path> <"target keyword">
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();

const htmlPath = process.argv[2];
const keyword = process.argv[3];

if (!htmlPath || !keyword) {
  console.error('Usage: node scripts/onpage-checklist.mjs <html-path> "<target keyword>"');
  process.exit(1);
}

// The extractors below are lazy regexes on bounded input: HTML is capped at 1 MB so a hostile page cannot stall them.
const html = readFileSync(resolve(ROOT, htmlPath), 'utf8').slice(0, 1_000_000);

// ─── Extract fields ───────────────────────────────────────────────────────────

const get = (regex, group = 1) => { const m = html.match(regex); return m ? m[group].trim() : null; };

const title = get(/<title[^>]*>([^<]+)<\/title>/i) || '';
// The character class must match the quote that actually opened the attribute. The old pattern
// allowed either quote to terminate, so a description containing an apostrophe was truncated at it:
// one page reported 21 chars against a real 152. Capture the opening quote and reuse it.
const metaDesc = get(/<meta\s+name=["']description["'][^>]*content=(["'])([\s\S]*?)\1/i, 2)
  || get(/<meta\s+content=(["'])([\s\S]*?)\1[^>]*name=["']description["']/i, 2) || '';
const h1 = get(/<h1[^>]*>([^<]+)<\/h1>/i)
  || get(/<h1[^>]*><[^>]+>([^<]+)<\/[^>]+><\/h1>/i) || '';
const url = get(/<link\s+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || htmlPath;

// All H2s
const h2s = [];
const h2regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
let m;
while ((m = h2regex.exec(html)) !== null) {
  const text = m[1].replace(/<[^>]+>/g, '').trim();
  if (text) h2s.push(text);
}

// Image alts
const alts = [];
const altRegex = /alt=["']([^"']+)["']/gi;
while ((m = altRegex.exec(html)) !== null) {
  alts.push(m[1]);
}

// Body text via w3m
const w3m = spawnSync('w3m', ['-dump', '-T', 'text/html', '-cols', '120'], {
  input: html, maxBuffer: 5 * 1024 * 1024
});
const bodyText = w3m.stdout.toString().toLowerCase();
const kw = keyword.toLowerCase();

// URL slug
const slugMatch = url.match(/^https?:\/\/[^/]+(\/.*)/);
const slug = slugMatch ? slugMatch[1] : url;

// ─── Score each dimension ─────────────────────────────────────────────────────

function scoreTitle() {
  const len = title.length;
  const hasKw = title.toLowerCase().includes(kw);
  const kwPos = title.toLowerCase().indexOf(kw);
  const early = kwPos >= 0 && kwPos < 30;
  const lenOk = len >= 30 && len <= 60;
  const status = hasKw && lenOk ? 'PASS' : hasKw || lenOk ? 'PARTIAL' : 'FAIL';
  return {
    status,
    value: title,
    chars: len,
    notes: [
      hasKw ? `keyword present (pos ${kwPos})` : 'keyword MISSING',
      lenOk ? `${len} chars (OK)` : `${len} chars (${len < 30 ? 'too short' : 'too long'})`,
      early ? 'keyword early' : 'keyword not in first 30 chars',
    ]
  };
}

function scoreH1() {
  const text = h1.replace(/<[^>]+>/g, '').trim();
  const len = text.length;
  const hasKw = text.toLowerCase().includes(kw);
  const lenOk = len <= 40;
  const diffFromTitle = text.toLowerCase() !== title.toLowerCase();
  const status = hasKw && lenOk ? 'PASS' : hasKw || lenOk ? 'PARTIAL' : 'FAIL';
  return {
    status,
    value: text,
    chars: len,
    notes: [
      hasKw ? 'keyword present' : 'keyword MISSING',
      lenOk ? `${len} chars (OK)` : `${len} chars (over 40)`,
      diffFromTitle ? 'different from title (OK)' : 'SAME AS TITLE (bad)',
    ]
  };
}

function scoreH2s() {
  const matchingH2s = h2s.filter(h => h.toLowerCase().includes(kw));
  const status = matchingH2s.length > 0 ? 'PASS' : 'FAIL';
  return {
    status,
    value: `${h2s.length} H2s total`,
    notes: [
      matchingH2s.length > 0
        ? `keyword in ${matchingH2s.length} H2(s): ${matchingH2s.map(h => `"${h}"`).join(', ')}`
        : `keyword in NONE of ${h2s.length} H2s`,
      `All H2s: ${h2s.map(h => `"${h}"`).join(' | ')}`
    ]
  };
}

function scoreBody() {
  const regex = new RegExp(kw.replace(/\s+/g, '\\s+'), 'gi');
  const matches = bodyText.match(regex) || [];
  const count = matches.length;
  const status = count >= 3 ? 'PASS' : count >= 1 ? 'PARTIAL' : 'FAIL';
  return {
    status,
    value: `${count} occurrences`,
    notes: [
      count >= 3 ? `${count}x, meets 3+ requirement` : `${count}x, needs ${3 - count} more`,
    ]
  };
}

function scoreMeta() {
  const hasKw = metaDesc.toLowerCase().includes(kw);
  const len = metaDesc.length;
  const kwPos = metaDesc.toLowerCase().indexOf(kw);
  const early = kwPos >= 0 && kwPos < 30;
  const lenOk = len >= 150 && len <= 160;
  const status = hasKw && lenOk ? 'PASS' : hasKw ? 'PARTIAL' : 'FAIL';
  return {
    status,
    value: metaDesc,
    chars: len,
    notes: [
      hasKw ? `keyword present (pos ${kwPos})` : 'keyword MISSING',
      lenOk ? `${len} chars (OK)` : `${len} chars (target 150-160)`,
      early ? 'keyword early' : 'keyword not in first 30 chars of meta',
    ]
  };
}

function scoreAlts() {
  const matching = alts.filter(a => a.toLowerCase().includes(kw));
  const status = matching.length > 0 ? 'PASS' : 'FAIL';
  return {
    status,
    value: `${alts.length} alts total`,
    notes: [
      matching.length > 0
        ? `keyword in ${matching.length} alt(s): ${matching.slice(0, 3).map(a => `"${a}"`).join(', ')}`
        : `keyword in NONE of ${alts.length} image alts`,
    ]
  };
}

function scoreUrl() {
  const kwWords = kw.split(/\s+/);
  const slugLower = slug.toLowerCase();
  const presentWords = kwWords.filter(w => slugLower.includes(w));
  const allPresent = presentWords.length === kwWords.length;
  const status = allPresent ? 'PASS' : presentWords.length > 0 ? 'PARTIAL' : 'FAIL';
  return {
    status,
    value: slug,
    notes: [
      allPresent
        ? 'all keyword words in URL'
        : `missing words: ${kwWords.filter(w => !slugLower.includes(w)).join(', ')}`,
      `present: ${presentWords.join(', ')}`
    ]
  };
}

// ─── Output ───────────────────────────────────────────────────────────────────

const results = {
  title: scoreTitle(),
  h1: scoreH1(),
  h2s: scoreH2s(),
  body: scoreBody(),
  meta: scoreMeta(),
  alts: scoreAlts(),
  url: scoreUrl(),
};

const pass = Object.values(results).filter(r => r.status === 'PASS').length;
const partial = Object.values(results).filter(r => r.status === 'PARTIAL').length;
const fail = Object.values(results).filter(r => r.status === 'FAIL').length;

const statusIcon = { PASS: '✅', PARTIAL: '⚠️', FAIL: '❌' };

console.log(`\n## Onpage SEO checklist (7 dimensions)`);
console.log(`**Page:** ${htmlPath}`);
console.log(`**Target keyword:** "${keyword}"`);
console.log(`**Score:** ${pass}/7 PASS, ${partial}/7 PARTIAL, ${fail}/7 FAIL`);
console.log('');
console.log('| Dimension | Status | Value | Notes |');
console.log('|---|---|---|---|');

for (const [dim, result] of Object.entries(results)) {
  const icon = statusIcon[result.status];
  const notesStr = result.notes.join('; ');
  console.log(`| ${dim} | ${icon} ${result.status} | ${(result.value || '').slice(0, 60)} | ${notesStr} |`);
}
