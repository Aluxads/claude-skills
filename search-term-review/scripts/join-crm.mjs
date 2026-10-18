#!/usr/bin/env node
// Join Google Ads search terms to CRM outcomes and classify each term. Local only, no network.
// Usage: node join-crm.mjs --terms terms.csv --crm crm.csv [options] > classified.csv
// Terms CSV: output of search-terms.mjs (date,search_term,status,campaign,ad_group,cost,clicks,...).
// The CRM must carry a way back to the search term, one of:
//   --term-col <col>      CRM column holding the term (utm_term, {keyword} or search term passed on the landing URL)
//   --gclid-col <col>     CRM column holding the click id, plus --gclid-map map.csv
//   --gclid-map <file>    CSV with a gclid column and a search term column (from GA4, a click export or a landing log)
//     --map-gclid-col <col> (default gclid)   --map-term-col <col> (default search_term)
// Options:
//   --date-col <col>      CRM lead created date (default created)
//   --stage-col <col>     CRM stage or outcome (default stage)
//   --value-col <col>     CRM deal value (optional)
//   --won-values "closed,customer"   stage values (case insensitive) that count as a customer
//   --lag-days 30         days a lead needs to reach a decision; spend newer than this is too young to judge
//   --as-of YYYY-MM-DD    "today" for the lag model (default: last date in the terms file)
//   --min-clicks 10       below this many clicks a term is low volume
// Output: classification CSV to stdout, counts to stderr. No contact data is read or written beyond the columns named.
// No dependencies. Node 18 or newer.
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(2); };

const termsFile = opt('--terms');
const crmFile = opt('--crm');
if (!termsFile || !crmFile) die('usage: node join-crm.mjs --terms terms.csv --crm crm.csv [--term-col c | --gclid-col c --gclid-map map.csv] [--date-col c] [--stage-col c] [--value-col c] [--won-values "closed,customer"] [--lag-days 30] [--as-of YYYY-MM-DD] [--min-clicks 10]');

const termCol = opt('--term-col');
const gclidCol = opt('--gclid-col');
const gclidMap = opt('--gclid-map');
const dateCol = opt('--date-col', 'created');
const stageCol = opt('--stage-col', 'stage');
const valueCol = opt('--value-col');
const won = new Set(opt('--won-values', 'closed,customer,won').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const lag = Number(opt('--lag-days', 30));
const minClicks = Number(opt('--min-clicks', 10));
if (!termCol && !(gclidCol && gclidMap)) die('need --term-col, or --gclid-col with --gclid-map (a gclid alone does not name a search term)');
if (!Number.isFinite(lag) || lag < 0) die('--lag-days must be a number >= 0');

function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}
function load(file) {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (!rows.length) die(`empty file: ${file}`);
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return { head, data: rows.slice(1) };
}
const col = (head, name, file) => {
  const i = head.indexOf(String(name).toLowerCase());
  if (i < 0) die(`column "${name}" not found in ${file}; have: ${head.join(', ')}`);
  return i;
};
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const day = (s) => { const t = Date.parse(String(s).trim()); return Number.isNaN(t) ? null : Math.floor(t / 86400000); };
const dayStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// terms, aggregated per search term
const T = load(termsFile);
const ti = Object.fromEntries(['date', 'search_term', 'campaign', 'ad_group', 'cost', 'clicks', 'conversions'].map((n) => [n, col(T.head, n, termsFile)]));
const rowsT = T.data.map((r) => ({
  day: day(r[ti.date]), term: norm(r[ti.search_term]), campaign: r[ti.campaign], adGroup: r[ti.ad_group],
  cost: Number(r[ti.cost]) || 0, clicks: Number(r[ti.clicks]) || 0, conv: Number(r[ti.conversions]) || 0,
})).filter((r) => r.day !== null && r.term);
if (!rowsT.length) die('no usable rows in terms file');
const firstDay = Math.min(...rowsT.map((r) => r.day));
const lastDay = Math.max(...rowsT.map((r) => r.day));
const asOfOpt = opt('--as-of');
const asOf = asOfOpt ? day(asOfOpt) : lastDay;
if (asOf === null) die('--as-of is not a date');
const youngFrom = asOf - lag + 1; // days >= youngFrom are too young to judge

const agg = new Map();
for (const r of rowsT) {
  let a = agg.get(r.term);
  if (!a) { a = { term: r.term, camps: new Set(), groups: new Set(), cost: 0, young: 0, clicks: 0, matClicks: 0, conv: 0, leads: 0, youngLeads: 0, cust: 0, value: 0 }; agg.set(r.term, a); }
  a.camps.add(r.campaign); a.groups.add(r.adGroup);
  a.cost += r.cost; a.clicks += r.clicks; a.conv += r.conv;
  if (r.day >= youngFrom) a.young += r.cost; else a.matClicks += r.clicks;
}

// gclid -> term map
let g2t = null;
if (gclidMap) {
  const M = load(gclidMap);
  const gi = col(M.head, opt('--map-gclid-col', 'gclid'), gclidMap);
  const si = col(M.head, opt('--map-term-col', 'search_term'), gclidMap);
  g2t = new Map(M.data.map((r) => [String(r[gi]).trim(), norm(r[si])]).filter(([g, t]) => g && t));
}

// crm
const C = load(crmFile);
const di = col(C.head, dateCol, crmFile);
const si = col(C.head, stageCol, crmFile);
const vi = valueCol ? col(C.head, valueCol, crmFile) : -1;
const tci = termCol ? col(C.head, termCol, crmFile) : -1;
const gci = gclidCol ? col(C.head, gclidCol, crmFile) : -1;
const stat = { crmRows: C.data.length, outOfRange: 0, noKey: 0, unmatchedTerm: 0, matched: 0 };
for (const r of C.data) {
  const d = day(r[di]);
  if (d === null || d < firstDay || d > lastDay) { stat.outOfRange++; continue; }
  let term = '';
  if (tci >= 0) term = norm(r[tci]);
  if (!term && g2t && gci >= 0) term = g2t.get(String(r[gci]).trim()) || '';
  if (!term) { stat.noKey++; continue; }
  const a = agg.get(term);
  if (!a) { stat.unmatchedTerm++; continue; }
  stat.matched++;
  a.leads++;
  if (d >= youngFrom) a.youngLeads++;
  if (won.has(norm(r[si]))) { a.cust++; if (vi >= 0) a.value += Number(String(r[vi]).replace(/[^0-9.\-]/g, '')) || 0; }
}

// classify
const out = [...agg.values()].map((a) => {
  const mature = a.cost - a.young;
  let cls, action;
  if (a.cust > 0) { cls = 'converting_to_customers'; action = 'keep, consider exact match and more budget'; }
  else if (a.leads > 0) { cls = 'converting_to_leads_only'; action = a.youngLeads ? 'keep, recent leads may still close' : 'keep, watch lead quality'; }
  else if (a.clicks < minClicks) { cls = 'low_volume'; action = 'no call yet, wait for more clicks'; }
  else if (a.matClicks < minClicks) { cls = 'too_young'; action = 'do not judge, re-run after the lag window'; }
  else { cls = 'zero_lead'; action = 'negative candidate, needs sign off'; }
  return { a, mature, cls, action };
}).sort((x, y) => y.a.cost - x.a.cost);

console.log('search_term,campaigns,ad_groups,cost,mature_cost,young_cost,clicks,ads_conversions,crm_leads,crm_customers,crm_value,class,suggested_action,spend_saved_if_negative');
const counts = {}; let saved = 0;
for (const { a, mature, cls, action } of out) {
  const s = cls === 'zero_lead' ? mature : 0;
  saved += s;
  counts[cls] = (counts[cls] || 0) + 1;
  console.log([a.term, [...a.camps].join(' | '), [...a.groups].join(' | '), a.cost.toFixed(2), mature.toFixed(2), a.young.toFixed(2),
    a.clicks, a.conv.toFixed(2), a.leads, a.cust, a.value.toFixed(2), cls, action, s.toFixed(2)].map(esc).join(','));
}
console.error(`terms: ${out.length}, terms range: ${dayStr(firstDay)} to ${dayStr(lastDay)}, as of: ${dayStr(asOf)}, lag days: ${lag} (young from ${dayStr(youngFrom)})`);
console.error(`crm rows: ${stat.crmRows}, matched to a term: ${stat.matched}, out of range: ${stat.outOfRange}, no term or gclid match: ${stat.noKey}, term not in spend file: ${stat.unmatchedTerm}`);
console.error(`classes: ${JSON.stringify(counts)}`);
console.error(`spend on zero_lead terms (mature only, excludes too young): ${saved.toFixed(2)} of ${out.reduce((s, o) => s + o.a.cost, 0).toFixed(2)}`);
