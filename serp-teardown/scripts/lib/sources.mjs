// sources.mjs: the two swappable seams. Node stdlib only.
//
// SEAM 1, SERP source: getSerp(mode, query, opts) returns the normalized shape
//   { query, source, gl, hl, location, pulledAt, credits, organic:[{position,url,domain,title,snippet}],
//     features:{ localPack:[], peopleAlsoAsk:[], relatedSearches:[], answerBox:null, ads:[], topStories:[], ... }, raw }
// To add SerpAPI or DataForSEO: write `async function serpapiSearch(query, opts)` (or dataforseoSearch) that
// calls the vendor and returns exactly that shape, then add a case in getSerp() and in the --serp choices.
//
// SEAM 2, metrics source: loadMetrics(mode, opts) returns { source, map: Map(queryLower -> {volume,difficulty,cpc}), warning }
// To add a vendor (Ubersuggest API, DataForSEO, Ads): write a loader returning the same map, add a case.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostOf, regDomain } from "./extract.mjs";

// ---- key loading (cwd relative .env, value never printed) ----
function parseEnvFile(file) {
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return env;
}

export function loadSerperKey(cwd = process.cwd()) {
  if (process.env.SERPER_API_KEY) return process.env.SERPER_API_KEY;
  const file = join(cwd, ".env");
  if (existsSync(file)) {
    const v = parseEnvFile(file).SERPER_API_KEY;
    if (v) return v;
  }
  throw new Error("SERPER_API_KEY missing: set the env var or add SERPER_API_KEY=... to .env in the current directory (key from serper.dev). Or use --serp file.");
}

function normOrganic(list) {
  return list
    .filter((o) => o && (o.link || o.url))
    .map((o, i) => {
      const url = o.link || o.url;
      return { position: o.position ?? i + 1, url, domain: regDomain(hostOf(url)), title: o.title || "", snippet: o.snippet || "" };
    });
}

// ---- serper ----
export async function serperSearch(query, { gl = "us", hl = "en", location = "", num = 10, key }) {
  const body = { q: query, gl, hl, num };
  if (location) body.location = location;
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`serper ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const features = {
    localPack: (data.places || []).map((p) => ({ title: p.title, website: p.website || null, rating: p.rating ?? null, ratingCount: p.ratingCount ?? null, address: p.address || null })),
    peopleAlsoAsk: (data.peopleAlsoAsk || []).map((q) => ({ question: q.question, link: q.link || null })),
    relatedSearches: (data.relatedSearches || []).map((r) => r.query),
    answerBox: data.answerBox ? { title: data.answerBox.title || null, snippet: data.answerBox.snippet || data.answerBox.answer || null, link: data.answerBox.link || null } : null,
    knowledgeGraph: data.knowledgeGraph ? { title: data.knowledgeGraph.title || null, type: data.knowledgeGraph.type || null } : null,
    ads: (data.ads || []).map((a) => ({ title: a.title, link: a.link })),
    topStories: (data.topStories || []).map((s) => ({ title: s.title, link: s.link })),
    videos: (data.videos || []).map((v) => ({ title: v.title, link: v.link })),
    images: (data.images || []).length ? [{ count: data.images.length }] : [],
    shopping: (data.shopping || []).length ? [{ count: data.shopping.length }] : [],
  };
  return {
    query,
    source: "serper",
    gl, hl, location,
    pulledAt: new Date().toISOString(),
    credits: data.credits ?? 1,
    organic: normOrganic(data.organic || []).slice(0, 10),
    features,
    raw: data,
  };
}

// ---- file source ----
// JSON object keyed by query. Value = array of organic results, or { organic:[...], peopleAlsoAsk:[...], relatedSearches:[...], localPack:[...], answerBox:{} }.
// Organic row: { url (or link), title?, snippet?, position? }. peopleAlsoAsk rows may be strings.
export function fileSearch(query, { file, gl = "", hl = "", location = "" }) {
  const all = JSON.parse(readFileSync(file, "utf8"));
  const key = Object.keys(all).find((k) => k.toLowerCase().trim() === query.toLowerCase().trim());
  if (!key) throw new Error(`--serp file: no entry for query "${query}" in ${file}`);
  const v = all[key];
  const obj = Array.isArray(v) ? { organic: v } : v;
  const paa = (obj.peopleAlsoAsk || []).map((q) => (typeof q === "string" ? { question: q, link: null } : q));
  return {
    query,
    source: "file",
    gl, hl, location,
    pulledAt: new Date().toISOString(),
    credits: 0,
    organic: normOrganic(obj.organic || []).slice(0, 10),
    features: {
      localPack: obj.localPack || [],
      peopleAlsoAsk: paa,
      relatedSearches: obj.relatedSearches || [],
      answerBox: obj.answerBox || null,
      ads: obj.ads || [],
      topStories: obj.topStories || [],
    },
    raw: obj,
  };
}

export async function getSerp(mode, query, opts) {
  if (mode === "serper") return serperSearch(query, opts);
  if (mode === "file") return fileSearch(query, opts);
  throw new Error(`unknown --serp "${mode}" (serper|file). To add serpapi or dataforseo see the header of sources.mjs.`);
}

// ---- metrics ----
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function parseMetrics(text, isCsv) {
  const map = new Map();
  const put = (k, o) => {
    const key = String(k || "").toLowerCase().trim();
    if (!key) return;
    const m = { volume: num(o.volume ?? o.avg_monthly_searches ?? o.searchVolume), difficulty: num(o.difficulty ?? o.seoDifficulty), cpc: num(o.cpc) };
    // optional Ads fields, carried through when present (metrics.json written by the ads adapter)
    if (o.competition) m.competition = String(o.competition);
    for (const f of ["competitionIndex", "cpcLow", "cpcHigh"]) if (num(o[f]) != null) m[f] = num(o[f]);
    map.set(key, m);
  };
  if (isCsv) {
    const [head, ...rows] = parseCsv(text);
    const cols = head.map((h) => h.trim().toLowerCase());
    for (const r of rows) {
      const o = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
      put(o.keyword ?? o.query, o);
    }
  } else {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : Array.isArray(data.rows) ? data.rows : Object.entries(data).map(([k, v]) => ({ keyword: k, ...(typeof v === "object" ? v : { volume: v }) }));
    for (const o of list) put(o.keyword ?? o.query, o);
  }
  return map;
}

// ---- Google Ads keyword metrics (read only: generateKeywordHistoricalMetrics) ----
// Small maps on purpose. Unmapped code = clear error, add a row.
export const GEO_IDS = { th: 2764, us: 2840, gb: 2826, uk: 2826, au: 2036, ca: 2124, sg: 2702, my: 2458, id: 2360, vn: 2704, ph: 2608, in: 2356, de: 2276, fr: 2250, es: 2724, it: 2380, jp: 2392, kr: 2410, hk: 2344, nz: 2554, ae: 2784 };
export const LANG_IDS = { en: 1000, th: 1044, de: 1001, fr: 1002, es: 1003, it: 1004, ja: 1005, ko: 1012, zh: 1017, id: 1025, vi: 1040, ms: 1102, pt: 1014, ru: 1031, ar: 1019 };

export function adsTargets(gl, hl) {
  const g = GEO_IDS[String(gl || "").toLowerCase()];
  const l = LANG_IDS[String(hl || "").toLowerCase()];
  if (!g) throw new Error(`--gl "${gl}" has no Ads geo target mapped (known: ${Object.keys(GEO_IDS).join(",")}). Add it to GEO_IDS in sources.mjs.`);
  if (!l) throw new Error(`--hl "${hl}" has no Ads language mapped (known: ${Object.keys(LANG_IDS).join(",")}). Add it to LANG_IDS in sources.mjs.`);
  return { geo: `geoTargetConstants/${g}`, language: `languageConstants/${l}` };
}

// Maps a generateKeywordHistoricalMetrics response to Map(keywordLower -> metrics). Bids are micros of account currency.
export function mapAdsResponse(payload) {
  const map = new Map();
  for (const r of payload?.results || []) {
    const key = String(r.text || "").toLowerCase().trim();
    if (!key) continue;
    const m = r.keywordMetrics || {};
    const lo = num(m.lowTopOfPageBidMicros), hi = num(m.highTopOfPageBidMicros);
    const cur = (v) => (v == null ? null : Math.round(v / 10000) / 100);
    const comp = m.competition && m.competition !== "UNSPECIFIED" ? String(m.competition) : null;
    map.set(key, {
      volume: num(m.avgMonthlySearches), difficulty: null,
      cpc: cur(hi), cpcLow: cur(lo), cpcHigh: cur(hi),
      competition: comp, competitionIndex: num(m.competitionIndex),
    });
  }
  return map;
}

// economy: loads your own Google Ads client module by dynamic import and calls its exported gadsCall (read only RPC), instead of a
// second auth stack. The module is NEVER auto discovered: it runs only when you pass --ads-client <path> explicitly, because
// importing a file executes its code. Ceiling: needs that module plus the two env vars in <cwd>/.env.
// Upgrade path: direct REST call with a service account JWT, or an OAuth refresh token, for repos without that client.
// The client reads the account from GADS_ACCOUNT or GADS_CUSTOMER_ID (keyword metrics do not depend on the account).
export function adsAvailable(cwd, adsClient) {
  if (!adsClient) return "no --ads-client <path> given";
  const client = resolve(cwd, adsClient);
  const envFile = join(cwd, ".env");
  if (!existsSync(client)) return `--ads-client file not found: ${adsClient}`;
  if (!existsSync(envFile)) return "no .env";
  const e = parseEnvFile(envFile);
  if (!e.GOOGLE_ADS_SERVICE_ACCOUNT_JSON || !e.GOOGLE_ADS_DEVELOPER_TOKEN) return "GOOGLE_ADS_SERVICE_ACCOUNT_JSON or GOOGLE_ADS_DEVELOPER_TOKEN missing in .env";
  return null;
}

// Strip secrets from an Ads client error before it is printed or written: values of GOOGLE_ADS_* / GADS_* env vars
// (process env and cwd .env), then any 32+ char token like string. Capped at 300 chars.
export function redactError(message, cwd = process.cwd()) {
  let out = String(message ?? "");
  const vals = new Set();
  const collect = (env) => { for (const [k, v] of Object.entries(env)) if (/^(GOOGLE_ADS_|GADS_)/.test(k) && v && String(v).length >= 4) vals.add(String(v)); };
  collect(process.env);
  try { const f = join(cwd, ".env"); if (existsSync(f)) collect(parseEnvFile(f)); } catch { /* ignore unreadable .env */ }
  for (const v of [...vals].sort((x, y) => y.length - x.length)) out = out.split(v).join("***");
  out = out.replace(/[A-Za-z0-9_-]{32,}/g, "***");
  return out.slice(0, 300);
}

export async function adsMetrics({ queries, gl, hl, cwd, adsClient }) {
  const { geo, language } = adsTargets(gl, hl);
  const why = adsAvailable(cwd, adsClient);
  if (why) throw new Error(why);
  const { gadsCall } = await import(pathToFileURL(resolve(cwd, adsClient)).href);
  const body = { keywords: queries, keywordPlanNetwork: "GOOGLE_SEARCH_AND_PARTNERS", geoTargetConstants: [geo], language };
  const payload = await gadsCall("generateKeywordHistoricalMetrics", body);
  return mapAdsResponse(payload);
}

export function metricsToRows(map) {
  return [...map.entries()].map(([keyword, m]) => ({ keyword, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)) }));
}

// mode: auto | ads | file | none. batchDir/metrics.json is the auto file location.
// auto = ads only if --ads-client <path> was passed and credentials resolve, else batchDir/metrics.json, else none. Never throws.
export async function loadMetrics(mode, { file, batchDir, queries = [], gl, hl, cwd = process.cwd(), adsClient }) {
  const fromFile = (f, label) => ({ source: label, map: parseMetrics(readFileSync(f, "utf8"), /\.csv$/i.test(f)), warning: null });
  const none = (warning) => ({ source: "none", map: new Map(), warning });
  if (mode === "none") return none(null);
  if (mode === "file") {
    if (!file || !existsSync(file)) return none(`--metrics file: ${file || "(no --metrics-file)"} not found, continuing without metrics`);
    return fromFile(file, `file:${file}`);
  }
  const auto = join(batchDir, "metrics.json");
  let adsWarn = null;
  const unavailable = mode === "auto" ? adsAvailable(cwd, adsClient) : null;
  if (mode === "ads" || !unavailable) {
    try {
      const map = await adsMetrics({ queries, gl, hl, cwd, adsClient });
      return { source: "ads", map, warning: null };
    } catch (e) {
      adsWarn = `ads metrics failed: ${redactError(e.message, cwd)}`;
    }
  } else adsWarn = `ads metrics unavailable (${redactError(unavailable, cwd)})`;
  if (mode === "auto" && existsSync(auto)) {
    try { const r = fromFile(auto, `file:${auto}`); r.warning = adsWarn; return r; } catch (e) { adsWarn += `; ${auto} unreadable`; }
  }
  return none(`${adsWarn}; continuing without volume, cpc, competition`);
}
