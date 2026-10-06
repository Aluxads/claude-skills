// analyze.mjs: consensus, own page gap, overlap clustering, diff. Pure functions, no IO.

import { hostOf, hostMatches, regDomain } from "./extract.mjs";

export const STOPWORDS = new Set(
  "a an the and or but of in on at to for from by with without about as is are was were be been being it its this that these those you your our we they their i my me he she him her his hers them us do does did can could should would will may might must not no yes if then than so such into over under up down out off per via vs what which who whom how when where why all any each more most other some very just also get gets got".split(" ")
);

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

export function tokens(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean);
}

// 1 to 3 word n-grams of one heading, stopwords dropped first
export function ngrams(text) {
  const t = tokens(text).filter((w) => !STOPWORDS.has(w) && w.length > 1);
  const out = new Set();
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

export function threshold(n) {
  return Math.max(3, Math.ceil(0.4 * n));
}

// terms present in >= threshold pages; a shorter term is dropped when a longer term containing it has the same count
export function termConsensus(pageTexts, minCount) {
  const counts = new Map();
  for (const texts of pageTexts) {
    const seen = new Set();
    for (const t of texts) for (const g of ngrams(t)) seen.add(g);
    for (const g of seen) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const kept = [...counts].filter(([, c]) => c >= minCount).map(([term, count]) => ({ term, count }));
  const filtered = kept.filter((a) => !kept.some((b) => b.term !== a.term && b.count === a.count && b.term.split(" ").length > a.term.split(" ").length && (" " + b.term + " ").includes(" " + a.term + " ")));
  return filtered.sort((a, b) => b.count - a.count || b.term.split(" ").length - a.term.split(" ").length || a.term.localeCompare(b.term));
}

const share = (n, d) => (d ? Math.round((n / d) * 100) / 100 : null);
const tally = (arr) => {
  const m = {};
  for (const v of arr) m[v] = (m[v] || 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};

export function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return String(u || "").toLowerCase();
  }
}

// serp = normalized serp ({organic:[{position,url,...}], features:{}}), pages = facts per organic result (same order, with .position)
export function consensus(query, serp, pages) {
  const comps = pages.filter((p) => p.fetched && p.domainClass !== "own");
  const n = comps.length;
  const min = threshold(n);
  const qLower = query.toLowerCase();
  const qWords = [...new Set(tokens(query).filter((w) => !STOPWORDS.has(w)))];
  const titles = comps.map((p) => p.title || "");
  const metas = comps.map((p) => p.metaDescription || "");
  const words = comps.map((p) => p.wordCount);

  const titleTerms = termConsensus(titles.map((t) => [t]), min).slice(0, 15);
  const schemaCount = {};
  for (const p of comps) for (const t of p.schemaTypes) schemaCount[t] = (schemaCount[t] || 0) + 1;
  const schemaFreq = Object.fromEntries(Object.entries(schemaCount).sort((a, b) => b[1] - a[1]).map(([t, c]) => [t, { count: c, share: share(c, n) }]));

  return {
    query,
    competitorsUsed: n,
    fetchedTotal: pages.filter((p) => p.fetched).length,
    organicTotal: pages.length,
    unfetched: pages.filter((p) => !p.fetched).map((p) => ({ position: p.position, url: p.url, reason: p.reason })),
    termThreshold: min,
    wordCount: { median: median(words), min: words.length ? Math.min(...words) : null, max: words.length ? Math.max(...words) : null },
    headingTerms: termConsensus(comps.map((p) => [...p.h2, ...p.h3]), min),
    titles: {
      medianLength: median(titles.map((t) => t.length)),
      shareExactQuery: share(titles.filter((t) => t.toLowerCase().includes(qLower)).length, n),
      shareByWord: Object.fromEntries(qWords.map((w) => [w, share(titles.filter((t) => tokens(t).includes(w)).length, n)])),
      commonTerms: titleTerms,
      shareWithYear: share(titles.filter((t) => /\b(19|20)\d{2}\b/.test(t)).length, n),
      shareWithNumber: share(titles.filter((t) => /\d/.test(t)).length, n),
    },
    metas: {
      medianLength: median(metas.filter(Boolean).map((t) => t.length)),
      shareExactQuery: share(metas.filter((t) => t.toLowerCase().includes(qLower)).length, n),
      shareMissing: share(metas.filter((t) => !t).length, n),
    },
    schemaFreq,
    pageTypeMix: tally(comps.map((p) => p.pageType)),
    domainClassMix: tally(pages.filter((p) => p.fetched || p.domainClass).map((p) => p.domainClass)),
    directoryCount: pages.filter((p) => p.domainClass !== "site" && p.domainClass !== "own").length,
    medianImages: median(comps.map((p) => p.images.count)),
    shareFaq: share(comps.filter((p) => p.faq.signal).length, n),
    sharePrice: share(comps.filter((p) => p.price.count > 0).length, n),
    shareWhatsapp: share(comps.filter((p) => p.contact.whatsapp).length, n),
    shareTel: share(comps.filter((p) => p.contact.tel).length, n),
    features: Object.keys(serp.features || {}).filter((k) => {
      const v = serp.features[k];
      return Array.isArray(v) ? v.length > 0 : !!v;
    }),
  };
}

// own: facts for our page (or null). ownPosition: best organic position or null. note: why no page.
export function ownGap(cons, own, ownPosition, query, note) {
  if (!own) return { ownPosition, status: "no page", note: note || "own page not ranking, no URL given" };
  if (!own.fetched) return { ownPosition, status: "unfetched", url: own.url, note: `own page unusable: ${own.reason}` };
  const have = new Set([...own.h1, ...own.h2, ...own.h3].flatMap((h) => [...ngrams(h)]));
  const half = Math.ceil(cons.competitorsUsed / 2);
  const q = query.toLowerCase();
  return {
    ownPosition,
    status: "ok",
    url: own.finalUrl || own.url,
    wordCount: own.wordCount,
    medianWordCount: cons.wordCount.median,
    wordDelta: cons.wordCount.median == null ? null : own.wordCount - cons.wordCount.median,
    missingHeadingTerms: cons.headingTerms.filter((t) => !have.has(t.term)),
    missingSchemaTypes: Object.entries(cons.schemaFreq).filter(([t, v]) => v.count >= half && !own.schemaTypes.includes(t)).map(([t, v]) => ({ type: t, count: v.count })),
    ownSchemaTypes: own.schemaTypes,
    queryInTitle: (own.title || "").toLowerCase().includes(q),
    queryInH1: own.h1.some((h) => h.toLowerCase().includes(q)),
    queryInMeta: (own.metaDescription || "").toLowerCase().includes(q),
    faqSignal: own.faq.signal,
    ownPageType: own.pageType,
  };
}

// ---- batch level ----

export function overlapMatrix(serps) {
  const sets = serps.map((s) => ({
    q: s.query,
    urls: new Set(s.organic.map((o) => normUrl(o.url))),
    domains: new Set(s.organic.map((o) => regDomain(hostOf(o.url)))),
  }));
  const pairs = [];
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      pairs.push({
        a: sets[i].q,
        b: sets[j].q,
        sharedUrls: [...sets[i].urls].filter((u) => sets[j].urls.has(u)).length,
        sharedDomains: [...sets[i].domains].filter((d) => sets[j].domains.has(d)).length,
      });
    }
  return pairs;
}

// complete linkage: merge two clusters only when EVERY cross pair shares >= minShared URLs.
// Greedy: repeatedly merge the pair with the highest weakest link (ties: input order).
export function clusterQueries(queries, pairs, minShared) {
  const shared = (x, y) => {
    const p = pairs.find((q) => (q.a === x && q.b === y) || (q.a === y && q.b === x));
    return p ? p.sharedUrls : 0;
  };
  let groups = queries.map((q) => [q]);
  for (;;) {
    let best = null;
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const weakest = Math.min(...groups[i].flatMap((x) => groups[j].map((y) => shared(x, y))));
        if (weakest >= minShared && (!best || weakest > best.weakest)) best = { i, j, weakest };
      }
    if (!best) break;
    groups[best.i] = [...groups[best.i], ...groups[best.j]];
    groups.splice(best.j, 1);
  }
  groups = groups.map((g) => queries.filter((q) => g.includes(q))).sort((a, b) => queries.indexOf(a[0]) - queries.indexOf(b[0]));
  return groups.map((qs, i) => ({ id: i + 1, queries: qs, verdict: qs.length > 1 ? "one page can target these queries" : "own page" }));
}

// pairs at or above the threshold that ended in different clusters, plus pairs exactly 1 below it
export function borderlinePairs(pairs, clusters, minShared) {
  const cid = (q) => clusters.find((c) => c.queries.includes(q))?.id;
  return [
    ...pairs.filter((p) => p.sharedUrls >= minShared && cid(p.a) !== cid(p.b)).map((p) => ({ ...p, kind: "at or above threshold, not clustered together" })),
    ...pairs.filter((p) => p.sharedUrls === minShared - 1).map((p) => ({ ...p, kind: "1 below threshold" })),
  ];
}

export function domainLeaderboard(serps) {
  const m = new Map();
  for (const s of serps)
    for (const o of s.organic) {
      const d = regDomain(hostOf(o.url));
      const e = m.get(d) || { domain: d, queries: new Set(), positions: [] };
      e.queries.add(s.query);
      e.positions.push(o.position);
      m.set(d, e);
    }
  return [...m.values()]
    .map((e) => ({ domain: e.domain, queries: e.queries.size, avgPosition: Math.round((e.positions.reduce((a, b) => a + b, 0) / e.positions.length) * 10) / 10 }))
    .sort((a, b) => b.queries - a.queries || a.avgPosition - b.avgPosition);
}

export function ownPositionOf(serp, ownDomains) {
  const hit = serp.organic.find((o) => ownDomains.some((d) => hostMatches(hostOf(o.url), d)));
  return hit ? { position: hit.position, url: hit.url } : null;
}

// ---- diff between two serps of the same query ----
export function diffSerps(prev, cur, ownDomains = []) {
  const pm = new Map(prev.organic.map((o) => [normUrl(o.url), o]));
  const cm = new Map(cur.organic.map((o) => [normUrl(o.url), o]));
  const newUrls = [...cm].filter(([k]) => !pm.has(k)).map(([, o]) => ({ position: o.position, url: o.url }));
  const droppedUrls = [...pm].filter(([k]) => !cm.has(k)).map(([, o]) => ({ position: o.position, url: o.url }));
  const moves = [...cm]
    .filter(([k, o]) => pm.has(k) && pm.get(k).position !== o.position)
    .map(([k, o]) => ({ url: o.url, from: pm.get(k).position, to: o.position }))
    .sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to));
  const a = ownPositionOf(prev, ownDomains);
  const b = ownPositionOf(cur, ownDomains);
  return { newUrls, droppedUrls, moves, ownBefore: a ? a.position : null, ownAfter: b ? b.position : null };
}
