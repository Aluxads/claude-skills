#!/usr/bin/env node
// Tag autocomplete suggestions with intent labels, cross with GSC keyword-page map, emit summary.
// Usage: node tag-and-cross.mjs --run <dir> --gsc <csv>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') out.run = argv[++i];
    else if (argv[i] === '--gsc') out.gsc = argv[++i];
  }
  return out;
}

// RFC4180-ish CSV parser handling quoted fields with embedded doubled quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0] === ''));
}

function toRecords(rows) {
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const rec = {};
    header.forEach((h, i) => { rec[h] = r[i] ?? ''; });
    return rec;
  });
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(filePath, header, records) {
  const lines = [header.join(',')];
  for (const rec of records) {
    lines.push(header.map((h) => csvEscape(rec[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function norm(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// ---- intent term lists (example values, edit these for your niche) ----
// adult and onsite_fit lists live in terms.json next to this script. Replace its values for your niche
// (keys: adult, onsite_fit.core, onsite_fit.room_words) and keep the file in the same folder.
const TERMS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'terms.json'), 'utf8'));
const ADULT_TERMS = TERMS.adult || [];
const SHOP_TERMS = ['shop', 'store', 'studio', 'salon', 'opening hours', 'address', 'walk in', 'walk-in', 'booking'];
const ONSITE_CORE_TERMS = (TERMS.onsite_fit && TERMS.onsite_fit.core) || [];
const ONSITE_ROOM_WORDS = (TERMS.onsite_fit && TERMS.onsite_fit.room_words) || [];
const INFO_TERMS = ['how much', 'how', 'what', 'why', 'where', 'when', 'tip', 'tips', 'price', 'prices', 'cost', 'review', 'reviews', 'reddit', 'quora', 'legal', 'safe', 'scam'];
const SERVICE_TERMS = ['basic', 'premium', 'standard', 'express', 'deluxe', 'family', 'team'];
const FOREIGN_TERMS = ['london', 'sydney', 'melbourne', 'toronto', 'new york'];
// non-ASCII chars flag a foreign-language row (CJK, Cyrillic, Arabic, etc.); widen the range for your own language
const FOREIGN_SCRIPT_RE = /[^\x00-\x7F]/;

function hasTerm(s, term) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`\\b${esc}\\b`).test(s);
}

function tagIntent(suggestion) {
  const s = norm(suggestion);
  const labels = [];

  const isAdult = ADULT_TERMS.some((t) => hasTerm(s, t));
  if (isAdult) labels.push('adult');

  const isForeign = FOREIGN_TERMS.some((t) => hasTerm(s, t)) || FOREIGN_SCRIPT_RE.test(suggestion);
  if (isForeign) labels.push('foreign');

  const isShopTerm = SHOP_TERMS.some((t) => hasTerm(s, t));
  const hasNearMe = hasTerm(s, 'near me');
  const hasRoomWord = ONSITE_ROOM_WORDS.some((t) => hasTerm(s, t)) || hasTerm(s, 'on site');

  const isOnsite = ONSITE_CORE_TERMS.some((t) => hasTerm(s, t)) || (hasNearMe && hasRoomWord);
  if (isOnsite) labels.push('onsite_fit');

  // "near me" with no on site/home context leans shop/local
  if (hasNearMe && !hasRoomWord) labels.push('shop_or_local');
  if (isShopTerm) labels.push('shop');

  const isInfo = INFO_TERMS.some((t) => hasTerm(s, t));
  if (isInfo) labels.push('info');

  const isService = SERVICE_TERMS.some((t) => hasTerm(s, t));
  if (isService) labels.push('service');

  if (!labels.length) labels.push('other');
  // dedupe preserving order
  return [...new Set(labels)].join('|');
}

function main() {
  const { run, gsc } = parseArgs(process.argv.slice(2));
  if (!run || !gsc) {
    console.error('usage: tag-and-cross.mjs --run <dir> --gsc <csv>');
    process.exit(1);
  }
  const suggPath = path.join(run, 'suggestions.csv');
  const suggRows = parseCsv(fs.readFileSync(suggPath, 'utf8'));
  const suggHeader = suggRows[0];
  const suggestions = toRecords(suggRows);

  const gscRows = parseCsv(fs.readFileSync(gsc, 'utf8'));
  const gscRecords = toRecords(gscRows);

  // ---- step 1: tag ----
  for (const rec of suggestions) {
    rec.intent = tagIntent(rec.suggestion);
  }
  const taggedHeader = [...suggHeader, 'intent'];
  writeCsv(path.join(run, 'tagged.csv'), taggedHeader, suggestions);

  // ---- step 2: cross with GSC ----
  // exact index: normalized query -> array of {page, impr, pos}
  const exactIndex = new Map();
  const gscWordIndex = []; // {words:Set, page, impr, pos, query}
  for (const g of gscRecords) {
    const q = norm(g.query);
    const impr = Number(g.impressions) || 0;
    const pos = Number(g.position) || 0;
    const entry = { page: g.page, impr, pos, query: q };
    if (!exactIndex.has(q)) exactIndex.set(q, []);
    exactIndex.get(q).push(entry);
    gscWordIndex.push({ words: new Set(q.split(' ').filter(Boolean)), ...entry });
  }
  // pick best exact match: lowest position, tie-break higher impressions
  function bestOf(entries) {
    return entries.slice().sort((a, b) => (a.pos - b.pos) || (b.impr - a.impr))[0];
  }

  for (const rec of suggestions) {
    const q = norm(rec.suggestion);
    rec.gsc_page = '';
    rec.gsc_impr = '';
    rec.gsc_pos = '';
    rec.gsc_partial = '';

    const exact = exactIndex.get(q);
    if (exact) {
      const best = bestOf(exact);
      rec.gsc_page = best.page;
      rec.gsc_impr = String(best.impr);
      rec.gsc_pos = String(best.pos);
      continue; // exact match found, skip fuzzy
    }

    const suggWords = q.split(' ').filter(Boolean);
    if (!suggWords.length) continue;
    let bestPartial = null;
    for (const g of gscWordIndex) {
      let allIn = true;
      for (const w of suggWords) {
        if (!g.words.has(w)) { allIn = false; break; }
      }
      if (!allIn) continue;
      if (!bestPartial || g.impr > bestPartial.impr || (g.impr === bestPartial.impr && g.pos < bestPartial.pos)) {
        bestPartial = g;
      }
    }
    if (bestPartial) rec.gsc_partial = bestPartial.page;
  }

  const crossedHeader = [...taggedHeader, 'gsc_page', 'gsc_impr', 'gsc_pos', 'gsc_partial'];
  writeCsv(path.join(run, 'crossed.csv'), crossedHeader, suggestions);

  // ---- step 3: summary ----
  const componentCounts = new Map();
  for (const rec of suggestions) {
    for (const label of rec.intent.split('|')) {
      componentCounts.set(label, (componentCounts.get(label) || 0) + 1);
    }
  }

  function hasLabel(rec, label) {
    return rec.intent.split('|').includes(label);
  }

  function gscMatchStr(rec) {
    if (rec.gsc_page) return `${rec.gsc_page} (pos ${Number(rec.gsc_pos).toFixed(1)})`;
    if (rec.gsc_partial) return `partial: ${rec.gsc_partial}`;
    return 'GAP';
  }

  function topTable(label, n = 30) {
    const rows = suggestions
      .filter((r) => hasLabel(r, label))
      .sort((a, b) => Number(b.relevance) - Number(a.relevance))
      .slice(0, n);
    const lines = ['| suggestion | seed | relevance | gsc match |', '|---|---|---|---|'];
    for (const r of rows) {
      lines.push(`| ${r.suggestion} | ${r.seed} | ${r.relevance} | ${gscMatchStr(r)} |`);
    }
    return lines.join('\n');
  }

  const trueGaps = suggestions.filter((r) => {
    const isTarget = hasLabel(r, 'onsite_fit') || hasLabel(r, 'info') || hasLabel(r, 'service');
    const noMatch = !r.gsc_page && !r.gsc_partial;
    return isTarget && noMatch && Number(r.relevance) >= 601;
  }).sort((a, b) => Number(b.relevance) - Number(a.relevance));

  const adultExamples = suggestions.filter((r) => hasLabel(r, 'adult')).slice(0, 10).map((r) => r.suggestion);
  const shopExamples = suggestions.filter((r) => hasLabel(r, 'shop') || hasLabel(r, 'shop_or_local')).slice(0, 10).map((r) => r.suggestion);
  const foreignCount = componentCounts.get('foreign') || 0;

  const summaryLines = [];
  summaryLines.push('# Autocomplete intent tagging summary');
  summaryLines.push('');
  summaryLines.push(`Total rows: ${suggestions.length}`);
  summaryLines.push('');
  summaryLines.push('## Counts per intent label (component-wise, rows can carry multiple labels)');
  summaryLines.push('');
  summaryLines.push('| label | count |');
  summaryLines.push('|---|---|');
  for (const [label, count] of [...componentCounts.entries()].sort((a, b) => b[1] - a[1])) {
    summaryLines.push(`| ${label} | ${count} |`);
  }
  summaryLines.push('');
  summaryLines.push('## onsite_fit top 30 by relevance');
  summaryLines.push('');
  summaryLines.push(topTable('onsite_fit'));
  summaryLines.push('');
  summaryLines.push('## info top 30 by relevance');
  summaryLines.push('');
  summaryLines.push(topTable('info'));
  summaryLines.push('');
  summaryLines.push('## service top 30 by relevance');
  summaryLines.push('');
  summaryLines.push(topTable('service'));
  summaryLines.push('');
  summaryLines.push(`## True gaps (onsite_fit/info/service, no GSC match, relevance >= 601): ${trueGaps.length}`);
  summaryLines.push('');
  summaryLines.push('| suggestion | seed | intent | relevance |');
  summaryLines.push('|---|---|---|---|');
  for (const r of trueGaps) {
    summaryLines.push(`| ${r.suggestion} | ${r.seed} | ${r.intent} | ${r.relevance} |`);
  }
  summaryLines.push('');
  summaryLines.push(`## Adult rows: ${componentCounts.get('adult') || 0} (for the record, no action)`);
  summaryLines.push('');
  for (const ex of adultExamples) summaryLines.push(`- ${ex}`);
  summaryLines.push('');
  summaryLines.push(`## Shop / shop_or_local rows: ${(componentCounts.get('shop') || 0) + (componentCounts.get('shop_or_local') || 0)} (for the record, no action)`);
  summaryLines.push('');
  for (const ex of shopExamples) summaryLines.push(`- ${ex}`);
  summaryLines.push('');
  summaryLines.push(`## Foreign rows: ${foreignCount}`);
  summaryLines.push('');

  fs.writeFileSync(path.join(run, 'summary.md'), summaryLines.join('\n') + '\n');

  console.log(`tagged.csv, crossed.csv, summary.md written to ${run}`);
  console.log(`rows: ${suggestions.length}, true gaps: ${trueGaps.length}`);
}

main();
