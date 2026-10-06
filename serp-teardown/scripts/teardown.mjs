#!/usr/bin/env node
// serp-teardown CLI. Node 18+, stdlib only, all paths relative to cwd. See ../SKILL.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { getSerp, loadSerperKey, loadMetrics, metricsToRows } from "./lib/sources.mjs";
import { fetchPage, buildPageFacts, pool, hostOf } from "./lib/extract.mjs";
import { consensus, ownGap, overlapMatrix, clusterQueries, borderlinePairs, domainLeaderboard, ownPositionOf, diffSerps } from "./lib/analyze.mjs";

const REPEATABLE = new Set(["own", "own-url"]);
const BOOL = new Set(["dry-run", "reuse-serp", "help"]);

function parseArgs(argv) {
  const o = { own: [], "own-url": [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v === undefined && !BOOL.has(k)) v = argv[++i];
    if (BOOL.has(k)) v = true;
    if (REPEATABLE.has(k)) o[k].push(v);
    else o[k] = v;
  }
  return o;
}

export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "query";
const cell = (s, n = 70) => String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, n);
const WEAK_BELOW = 6;
const weak = (cons) => (cons.fetchedTotal < WEAK_BELOW ? ` [weak sample: ${cons.fetchedTotal} fetched, under ${WEAK_BELOW}]` : "");
const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const write = (file, data) => writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function usage() {
  console.log(`usage: node teardown.mjs --queries "q1|q2" | --file queries.txt --own example.com
  [--own-url "query=url"] [--gl us] [--hl en] [--location "..."] [--serp serper|file] [--serp-file path]
  [--metrics auto|ads|file|none] [--metrics-file path] [--ads-client path] [--overlap 4] [--max-queries 25]
  [--directories a.com,b.com] [--out docs/seo/serp-teardown] [--reuse-serp] [--dry-run]
  --out must stay inside the current directory and must not be a symlink.
  --ads-client <path>: your own Google Ads client module (exports gadsCall). Never auto discovered; it is imported and run only when passed.`);
}

// a stored serp.json is one normalized serp object: { query, organic: [...], features: {...} }
function validSerp(x) {
  return x && typeof x === "object" && !Array.isArray(x) && Array.isArray(x.organic) && x.organic.every((o) => o && typeof o === "object")
    && (x.features == null || (typeof x.features === "object" && !Array.isArray(x.features)));
}

function findPrevious(outDir, today, batchSlugIgnored, qslug) {
  if (!existsSync(outDir)) return null;
  const dates = readdirSync(outDir).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d) && d < today).sort().reverse();
  for (const d of dates) {
    for (const b of readdirSync(join(outDir, d), { withFileTypes: true })) {
      if (!b.isDirectory()) continue;
      const f = join(outDir, d, b.name, qslug, "serp.json");
      if (!existsSync(f)) continue;
      try {
        const serp = JSON.parse(readFileSync(f, "utf8"));
        if (!validSerp(serp)) throw new Error("unexpected shape");
        return { date: d, serp };
      } catch (e) {
        console.warn(`warning: ignoring previous run ${f}: ${e.message}`);
      }
    }
  }
  return null;
}

function queryMd(q, today) {
  const { query, serp, pages, cons, gap, diff, prevDate, metrics } = q;
  const L = [`# Teardown: ${query}`, "", `Date ${today}. Source ${serp.source}, gl=${serp.gl || "n/a"} hl=${serp.hl || "n/a"}${serp.location ? ` location=${serp.location}` : ""}.`];
  if (metrics) L.push(`Volume ${metrics.volume ?? "n/a"}/month, competition ${metrics.competition ?? "n/a"}${metrics.competitionIndex != null ? ` (${metrics.competitionIndex})` : ""}, top of page bid ${metrics.cpcLow ?? "n/a"} to ${metrics.cpcHigh ?? "n/a"}, difficulty ${metrics.difficulty ?? "n/a"}.`);
  L.push("", "## Top 10", "");
  L.push(table(["pos", "url", "class", "page type", "title", "words", "h2", "schema"], pages.map((p) => [
    p.position, p.url, p.domainClass, p.fetched ? p.pageType : "unfetched", cell(p.fetched ? p.title : serp.organic.find((o) => o.url === p.url)?.title), p.fetched ? p.wordCount : "n/a", p.fetched ? p.h2.length : "n/a", p.fetched ? cell(p.schemaTypes.join(", "), 50) || "none" : "n/a",
  ])));
  L.push("", `## Consensus (${cons.competitorsUsed} fetched competitor pages, own page excluded, term threshold ${cons.termThreshold})`, "");
  L.push(`- Word count: median ${cons.wordCount.median ?? "n/a"}, min ${cons.wordCount.min ?? "n/a"}, max ${cons.wordCount.max ?? "n/a"}${weak(cons)}`);
  L.push(`- Titles: median length ${cons.titles.medianLength ?? "n/a"}, exact query in ${pct(cons.titles.shareExactQuery)}${weak(cons)}, with year ${pct(cons.titles.shareWithYear)}, with a number ${pct(cons.titles.shareWithNumber)}`);
  L.push(`- Title query words: ${Object.entries(cons.titles.shareByWord).map(([w, s]) => `${w} ${pct(s)}`).join(", ") || "n/a"}`);
  L.push(`- Title common terms: ${cons.titles.commonTerms.map((t) => `${t.term} (${t.count})`).join(", ") || "none"}`);
  L.push(`- Meta: median length ${cons.metas.medianLength ?? "n/a"}, exact query in ${pct(cons.metas.shareExactQuery)}, missing ${pct(cons.metas.shareMissing)}${weak(cons)}`);
  L.push(`- Schema: ${Object.entries(cons.schemaFreq).map(([t, v]) => `${t} ${v.count}`).join(", ") || "none"}`);
  L.push(`- Page types: ${Object.entries(cons.pageTypeMix).map(([t, c]) => `${t} ${c}`).join(", ") || "n/a"}`);
  L.push(`- Domain classes (top 10): ${Object.entries(cons.domainClassMix).map(([t, c]) => `${t} ${c}`).join(", ") || "n/a"}. Directories, aggregators and social: ${cons.directoryCount}, do not copy their layout.`);
  L.push(`- Signals: FAQ ${pct(cons.shareFaq)}, price text ${pct(cons.sharePrice)}, WhatsApp ${pct(cons.shareWhatsapp)}, tel ${pct(cons.shareTel)}, median images ${cons.medianImages ?? "n/a"}`);
  L.push(`- SERP features: ${cons.features.join(", ") || "none"}`);
  if (serp.features.peopleAlsoAsk?.length) L.push(`- People Also Ask: ${serp.features.peopleAlsoAsk.map((p) => p.question).join(" / ")}`);
  if (serp.features.relatedSearches?.length) L.push(`- Related searches: ${serp.features.relatedSearches.join(" / ")}`);
  L.push("", "### Heading terms shared by rankers", "");
  L.push(cons.headingTerms.length ? table(["term", "rankers"], cons.headingTerms.slice(0, 40).map((t) => [t.term, t.count])) : "None above threshold.");
  L.push("", "## Own page gap", "");
  if (gap.status !== "ok") L.push(`${gap.note}${gap.ownPosition ? ` Own position ${gap.ownPosition}.` : ""}`);
  else {
    L.push(`- URL: ${gap.url}`, `- Own position: ${gap.ownPosition ?? "not in top 10"}`, `- Word count: ${gap.wordCount} vs median ${gap.medianWordCount ?? "n/a"} (delta ${gap.wordDelta ?? "n/a"})`);
    L.push(`- Query in title: ${gap.queryInTitle ? "yes" : "no"}, h1: ${gap.queryInH1 ? "yes" : "no"}, meta: ${gap.queryInMeta ? "yes" : "no"}`);
    L.push(`- Own schema: ${gap.ownSchemaTypes.join(", ") || "none"}; missing schema used by half or more rankers: ${gap.missingSchemaTypes.map((s) => `${s.type} (${s.count})`).join(", ") || "none"}`);
    L.push(`- Missing heading terms: ${gap.missingHeadingTerms.map((t) => `${t.term} (${t.count})`).join(", ") || "none"}`);
  }
  if (diff) {
    L.push("", `## Since ${prevDate}`, "");
    L.push(`- Own position: ${diff.ownBefore ?? "none"} -> ${diff.ownAfter ?? "none"}`);
    L.push(`- New URLs: ${diff.newUrls.map((u) => `#${u.position} ${u.url}`).join(", ") || "none"}`);
    L.push(`- Dropped URLs: ${diff.droppedUrls.map((u) => `was #${u.position} ${u.url}`).join(", ") || "none"}`);
    L.push(`- Position moves: ${diff.moves.map((m) => `${m.url} ${m.from} -> ${m.to}`).join(", ") || "none"}`);
  }
  L.push("", "## Unfetched pages", "");
  L.push(cons.unfetched.length ? table(["pos", "url", "reason"], cons.unfetched.map((u) => [u.position, u.url, u.reason])) : "None. All pages fetched.");
  return L.join("\n") + "\n";
}

function summaryMd(b) {
  const L = [`# SERP teardown batch: ${b.batchSlug}`, "", `Date ${b.date}. ${b.queries.length} queries, gl=${b.params.gl} hl=${b.params.hl}, serp source ${b.params.serp}, metrics ${b.metricsSource}, overlap threshold ${b.params.overlap}.`, ""];
  if (b.warnings.length) L.push(...b.warnings.map((w) => `Warning: ${w}`), "");
  L.push("## Queries", "");
  L.push(table(["query", "volume", "competition", "bid low-high", "difficulty", "own position", "cluster", "features", "median words", "fetched"], b.queries.map((q) => [
    q.query, q.metrics?.volume ?? "n/a", q.metrics?.competition ?? "n/a", q.metrics?.cpcLow != null ? `${q.metrics.cpcLow}-${q.metrics.cpcHigh}` : "n/a", q.metrics?.difficulty ?? "n/a", q.ownPosition ?? (q.gap.status === "no page" ? "none" : "not in top 10"), q.cluster, cell(q.cons.features.join(", "), 60) || "none", `${q.cons.wordCount.median ?? "n/a"}${q.cons.fetchedTotal < WEAK_BELOW ? " (weak sample)" : ""}`, `${q.cons.fetchedTotal} of ${q.cons.organicTotal}`,
  ])));
  L.push("", "## Clusters", "");
  for (const c of b.clusters) L.push(`- Cluster ${c.id} (${c.verdict}): ${c.queries.join(" / ")}`);
  L.push("", "## Borderline pairs", "");
  L.push("Complete linkage: a query joins a cluster only when it shares the threshold with every member.", "");
  L.push(b.borderline.length ? b.borderline.map((p) => `- ${p.a} + ${p.b}: ${p.sharedUrls} shared URLs (${p.kind})`).join("\n") : "None.");
  L.push("", "## Overlap matrix (shared URLs / shared domains in top 10)", "");
  const qs = b.queries.map((q) => q.query);
  const get = (x, y) => b.overlap.find((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x));
  L.push(table(["", ...qs], qs.map((x) => [x, ...qs.map((y) => (x === y ? "-" : `${get(x, y).sharedUrls} / ${get(x, y).sharedDomains}`))])));
  L.push("", "## Domain leaderboard", "");
  L.push(table(["domain", "queries", "avg position"], b.leaderboard.slice(0, 25).map((d) => [d.domain, d.queries, d.avgPosition])));
  L.push("", `Serper credits used: ${b.creditsUsed}.`);
  return L.join("\n") + "\n";
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) return usage();
  const cwd = process.cwd();
  const date = new Date().toISOString().slice(0, 10);

  let queries = [];
  if (a.queries) queries.push(...a.queries.split("|"));
  if (a.file) queries.push(...readFileSync(resolve(cwd, a.file), "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")));
  queries = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  if (!queries.length) { usage(); throw new Error("no queries: pass --queries or --file"); }

  const maxQueries = Number(a["max-queries"] ?? 25);
  if (queries.length > maxQueries) throw new Error(`${queries.length} queries is above --max-queries ${maxQueries}. Raise it explicitly if intended (1 Serper credit per query).`);

  const own = (a.own || []).flatMap((d) => String(d).split(",")).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean);
  const ownUrlMap = {};
  for (const m of a["own-url"]) {
    const i = String(m).indexOf("=");
    if (i === -1) throw new Error(`--own-url needs "query=url", got: ${m}`);
    ownUrlMap[m.slice(0, i).trim().toLowerCase()] = m.slice(i + 1).trim();
    const h = hostOf(m.slice(i + 1).trim());
    if (h && !own.includes(h)) own.push(h);
  }
  const directories = String(a.directories || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const params = {
    gl: a.gl || "us", hl: a.hl || "en", location: a.location || "", serp: a.serp || "serper",
    overlap: Number(a.overlap ?? 4), metrics: a.metrics || "auto", out: a.out || "docs/seo/serp-teardown",
  };
  const outDir = resolve(cwd, params.out);
  const rel = relative(cwd, outDir);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error(`--out must stay inside the current directory, got: ${params.out}`);
  if (existsSync(outDir) && lstatSync(outDir).isSymbolicLink()) throw new Error(`--out is a symlink, refusing: ${params.out}`);
  const batchSlug = `${slugify(queries[0])}-${queries.length}q`;
  const batchDir = join(outDir, date, batchSlug);
  const qSlugs = queries.map(slugify);
  if (new Set(qSlugs).size !== qSlugs.length) throw new Error("two queries share the same slug, rename one");
  const reuse = !!a["reuse-serp"];
  const reusable = (qs) => reuse && existsSync(join(batchDir, qs, "serp.json"));
  const calls = params.serp === "serper" ? queries.filter((_, i) => !reusable(qSlugs[i])).length : 0;

  console.log(`plan: ${queries.length} queries, serp=${params.serp}, gl=${params.gl} hl=${params.hl}, own=${own.join(",") || "none"}`);
  console.log(`serper credits: ${calls} (1 per query${reuse ? ", reuse-serp skips existing" : ""}), page fetches: up to ${queries.length * 10} (concurrency 4, 15s timeout)`);
  console.log(`output: ${join(params.out, date, batchSlug)}/ (put metrics.json there before the run for --metrics auto)`);
  if (a["dry-run"]) { console.log("dry run: nothing called."); return; }

  const key = params.serp === "serper" ? loadSerperKey(cwd) : null;
  if (params.serp === "file" && !a["serp-file"]) throw new Error("--serp file needs --serp-file path");
  const serpOpts = { gl: params.gl, hl: params.hl, location: params.location, key, file: a["serp-file"] && resolve(cwd, a["serp-file"]) };

  // 1. SERPs
  let creditsUsed = 0;
  const serps = [];
  for (let i = 0; i < queries.length; i++) {
    if (reusable(qSlugs[i])) {
      serps.push(JSON.parse(readFileSync(join(batchDir, qSlugs[i], "serp.json"), "utf8")));
      console.log(`serp ${i + 1}/${queries.length} reused: ${queries[i]}`);
      continue;
    }
    const s = await getSerp(params.serp, queries[i], serpOpts);
    if (params.serp === "serper") creditsUsed += 1;
    serps.push(s);
    console.log(`serp ${i + 1}/${queries.length} ${s.organic.length} organic: ${queries[i]}`);
  }

  // 2. fetch every unique ranking URL (+ own URLs) once
  const ownRanked = serps.map((s) => ownPositionOf(s, own));
  const wanted = new Set(serps.flatMap((s) => s.organic.map((o) => o.url)));
  queries.forEach((q, i) => {
    const u = ownUrlMap[q.toLowerCase()];
    if (u && !ownRanked[i]) wanted.add(u);
  });
  const ctx = { own, directories };
  const urls = [...wanted];
  const done = { n: 0 };
  const facts = new Map();
  await pool(urls, 4, async (url) => {
    facts.set(url, buildPageFacts(await fetchPage(url), ctx));
    if (++done.n % 10 === 0 || done.n === urls.length) console.log(`fetched ${done.n}/${urls.length}`);
  });

  // 3. metrics
  const metrics = await loadMetrics(params.metrics, { file: a["metrics-file"] && resolve(cwd, a["metrics-file"]), batchDir, queries, gl: params.gl, hl: params.hl, cwd, adsClient: a["ads-client"] });
  if (metrics.source === "ads" && metrics.map.size) {
    mkdirSync(batchDir, { recursive: true });
    write(join(batchDir, "metrics.json"), metricsToRows(metrics.map));
  }
  metrics.warning = metrics.warning && metrics.warning.split(cwd + "/").join("");
  const warnings = metrics.warning ? [metrics.warning] : [];
  if (metrics.warning) console.warn(`warning: ${metrics.warning}`);

  // 4. per query analysis
  const results = serps.map((s, i) => {
    const pages = s.organic.map((o) => ({ ...facts.get(o.url), position: o.position, url: o.url }));
    const cons = consensus(s.query, s, pages);
    const ownHit = ownRanked[i];
    let ownFacts = ownHit ? facts.get(ownHit.url) : null;
    let note;
    if (!ownHit) {
      const u = ownUrlMap[s.query.toLowerCase()];
      if (u) ownFacts = facts.get(u);
      else note = own.length ? "own page not ranking, no URL given" : "no --own given";
    }
    const gap = ownGap(cons, ownFacts, ownHit ? ownHit.position : null, s.query, note);
    const prev = findPrevious(outDir, date, batchSlug, qSlugs[i]);
    return {
      query: s.query, slug: qSlugs[i], serp: s, pages, cons, gap, ownPosition: ownHit ? ownHit.position : null,
      metrics: metrics.map.get(s.query.toLowerCase()) || null,
      diff: prev ? diffSerps(prev.serp, s, own) : null, prevDate: prev ? prev.date : null,
    };
  });

  // 5. batch level
  const overlap = overlapMatrix(serps);
  const clusters = clusterQueries(queries, overlap, params.overlap);
  const leaderboard = domainLeaderboard(serps);
  const borderline = borderlinePairs(overlap, clusters, params.overlap);
  for (const r of results) r.cluster = clusters.find((c) => c.queries.includes(r.query)).id;
  const batch = { date, batchSlug, params, own, directories, metricsSource: metrics.source, warnings, creditsUsed, overlap, clusters, borderline, leaderboard, queries: results };

  mkdirSync(batchDir, { recursive: true });
  write(join(batchDir, "batch.json"), batch);
  write(join(batchDir, "summary.md"), summaryMd(batch));
  for (const r of results) {
    const d = join(batchDir, r.slug);
    mkdirSync(d, { recursive: true });
    write(join(d, "serp.json"), r.serp);
    write(join(d, "pages.json"), r.pages);
    write(join(d, "consensus.json"), { consensus: r.cons, ownGap: r.gap, diff: r.diff });
    write(join(d, "teardown.md"), queryMd(r, date));
  }
  for (const r of results) console.log(`${r.query}: fetched ${r.cons.fetchedTotal}/${r.cons.organicTotal}, median words ${r.cons.wordCount.median ?? "n/a"}, own ${r.ownPosition ?? "none"}, cluster ${r.cluster}`);
  console.log(`serper credits used: ${creditsUsed}`);
  console.log(`output: ${join(params.out, date, batchSlug)}/`);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
