#!/usr/bin/env node
// Google autocomplete mining script. Node 18+ ESM, no deps.
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

const HELP = `usage: node mining.mjs --seeds "a,b,c" | --seeds-file path [--locales us,gb] [--modes suffix,prefix,question] [--delay 250] [--out dir]
  --delay   ms between requests, minimum 250 (lower values are raised)
  --out     output dir, must stay inside the current directory and must not be a symlink (default docs/seo/autocomplete/<today>)
Calls Google's undocumented suggest endpoint: low volume, from your own IP, check Google's terms for your use.`;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const QUESTION_WORDS = [
  'how', 'what', 'where', 'why', 'when', 'is', 'are', 'can', 'do', 'does',
  'best', 'cheap', 'near', 'vs', 'for', 'with', 'without', 'price', 'cost', 'review',
];
const MAX_REQUESTS = 4000;
const REQUEST_TIMEOUT_MS = 10000;
const MIN_DELAY_MS = 250;
const MAX_RESPONSE_BYTES = 256 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function loadSeeds(args) {
  if (args['seeds-file']) {
    const raw = await readFile(args['seeds-file'], 'utf8');
    return raw.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (args.seeds) {
    return String(args.seeds).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function buildProbes(seed, modes) {
  const probes = [];
  probes.push({ query: seed, mode: 'bare' });
  if (modes.includes('suffix')) {
    for (const c of [...LETTERS, ...DIGITS]) {
      probes.push({ query: `${seed} ${c}`, mode: 'suffix' });
    }
  }
  if (modes.includes('prefix')) {
    for (const c of LETTERS) {
      probes.push({ query: `${c} ${seed}`, mode: 'prefix' });
    }
  }
  if (modes.includes('question')) {
    for (const w of QUESTION_WORDS) {
      probes.push({ query: `${w} ${seed}`, mode: 'question' });
      probes.push({ query: `${seed} ${w}`, mode: 'question' });
    }
  }
  return probes;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// stream the body and stop at MAX_RESPONSE_BYTES; an oversized response is an error, never parsed
async function readCapped(res) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_RESPONSE_BYTES) throw new Error('response over 256 KB');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error('response over 256 KB');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

async function fetchSuggestions(query, gl) {
  const url = new URL('https://suggestqueries.google.com/complete/search');
  url.searchParams.set('client', 'chrome');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', gl);
  url.searchParams.set('q', query);

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await readCapped(res);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch (e) {
    try {
      return await attempt();
    } catch (e2) {
      return null;
    }
  }
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const seeds = await loadSeeds(args);
  if (!seeds.length) {
    console.error('no seeds given: use --seeds "a,b,c" or --seeds-file path');
    process.exit(1);
  }
  const locales = String(args.locales || 'us').split(',').map((s) => s.trim()).filter(Boolean);
  const modes = String(args.modes || 'suffix,prefix,question').split(',').map((s) => s.trim()).filter(Boolean);
  let delay = Number(args.delay ?? MIN_DELAY_MS);
  if (!Number.isFinite(delay) || delay < MIN_DELAY_MS) {
    console.warn(`warning: --delay raised to the ${MIN_DELAY_MS} ms minimum`);
    delay = MIN_DELAY_MS;
  }
  const cwd = process.cwd();
  const outDir = args.out
    ? path.resolve(cwd, String(args.out))
    : path.resolve(cwd, 'docs/seo/autocomplete', todayStr());
  const rel = path.relative(cwd, outDir);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    console.error(`error: --out must stay inside the current directory, got: ${args.out}`);
    process.exit(1);
  }
  try {
    if ((await lstat(outDir)).isSymbolicLink()) {
      console.error(`error: --out is a symlink, refusing: ${args.out}`);
      process.exit(1);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // plan and guard
  let planned = 0;
  const perSeedProbes = new Map();
  for (const seed of seeds) {
    const probes = buildProbes(seed, modes);
    perSeedProbes.set(seed, probes);
    planned += probes.length * locales.length;
  }
  if (planned > MAX_REQUESTS) {
    console.error(`abort: planned ${planned} requests exceeds max ${MAX_REQUESTS}`);
    process.exit(1);
  }

  console.log(`plan: ${seeds.length} seeds x ${locales.length} locales, ${planned} total requests`);

  const seen = new Map(); // key: lowercase suggestion -> row
  const rows = [];
  const seedCounts = new Map();
  for (const seed of seeds) seedCounts.set(seed, 0);

  let requestCount = 0;
  let failures = 0;

  for (const locale of locales) {
    for (const seed of seeds) {
      const probes = perSeedProbes.get(seed);
      for (const probe of probes) {
        requestCount++;
        const data = await fetchSuggestions(probe.query, locale);
        if (!data) {
          failures++;
        } else {
          const suggestions = Array.isArray(data[1]) ? data[1] : [];
          const extra = data[4] && typeof data[4] === 'object' ? data[4] : {};
          const relevanceArr = extra['google:suggestrelevance'];
          suggestions.forEach((suggestion, idx) => {
            const key = String(suggestion).toLowerCase();
            if (seen.has(key)) return;
            const row = {
              suggestion,
              seed,
              mode: probe.mode,
              probe: probe.query,
              locale,
              relevance: Array.isArray(relevanceArr) && relevanceArr[idx] !== undefined ? relevanceArr[idx] : '',
              rank: idx,
            };
            seen.set(key, row);
            rows.push(row);
            seedCounts.set(seed, (seedCounts.get(seed) || 0) + 1);
          });
        }
        if (requestCount % 50 === 0) {
          console.log(`progress: ${requestCount}/${planned} requests, ${rows.length} unique, ${failures} failures`);
        }
        if (delay > 0) await sleep(delay);
      }
    }
  }

  await mkdir(outDir, { recursive: true });

  const header = 'suggestion,seed,mode,probe,locale,relevance,rank';
  const csvLines = [header, ...rows.map((r) => [
    csvEscape(r.suggestion), csvEscape(r.seed), csvEscape(r.mode),
    csvEscape(r.probe), csvEscape(r.locale), csvEscape(r.relevance), csvEscape(r.rank),
  ].join(','))];
  await writeFile(path.join(outDir, 'suggestions.csv'), csvLines.join('\n') + '\n', 'utf8');
  await writeFile(path.join(outDir, 'suggestions.json'), JSON.stringify(rows, null, 2), 'utf8');

  const summary = {
    args: { seeds, locales, modes, delay, out: outDir },
    timestamp: new Date().toISOString(),
    requests: requestCount,
    uniqueSuggestions: rows.length,
    failures,
    perSeedCounts: Object.fromEntries(seedCounts),
  };
  await writeFile(path.join(outDir, 'run.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('--- summary ---');
  console.log(`requests: ${requestCount}`);
  console.log(`unique suggestions: ${rows.length}`);
  console.log(`failures: ${failures}`);
  console.log('per seed counts:', summary.perSeedCounts);
  console.log(`out dir: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
