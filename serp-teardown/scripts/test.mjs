// Plain node:assert checks on inline fixtures. Run: node test.mjs
import assert from "node:assert/strict";
import { buildPageFacts, classifyDomain, regDomain, blockReason, isPrivateIp, fetchPage } from "./lib/extract.mjs";
import { median, ngrams, termConsensus, threshold, consensus, ownGap, overlapMatrix, clusterQueries, borderlinePairs, diffSerps } from "./lib/analyze.mjs";
import { parseMetrics, mapAdsResponse, adsTargets, metricsToRows, redactError, adsAvailable } from "./lib/sources.mjs";

const body = (n) => "<p>" + "word ".repeat(n) + "</p>";

// ---- extract ----
const html = `<html><head><title>Desk Lamp Paris 2026 | Brand</title>
<meta name="description" content="Hotel lamp &amp; more"><link rel="canonical" href="https://a.com/x/">
<meta name="robots" content="index,follow">
<script type="application/ld+json">{"@graph":[{"@type":"LocalBusiness"},{"@type":["Service","Thing"]}]}</script>
<script type="application/ld+json">[{"@type":"FAQPage"}]</script>
<style>.x{}</style></head><body>
<header><h2>Header junk</h2></header><nav><h2>Nav junk</h2><a href="/a">a</a></nav>
<main><h1>Desk Lamp</h1><h2>Prices</h2><h3>What is included?</h3><h2>Booking</h2>
${body(300)}<a href="/book">b</a><a href="https://ext.com/">e</a><a href="tel:+15550100">t</a>
<a href="https://wa.me/15550100">wa</a><img src="a.jpg" alt="one"><img src="b.jpg" alt=""><p>From USD 180 per hour</p></main>
<desker><h2>Footer junk</h2></desker><script>var x=1;</script></body></html>`;
const f = buildPageFacts({ url: "https://a.com/services/lamp/", finalUrl: "https://a.com/services/lamp/", status: 200, contentType: "text/html", html }, { own: [] });
assert.equal(f.fetched, true);
assert.equal(f.title, "Desk Lamp Paris 2026 | Brand");
assert.equal(f.metaDescription, "Hotel lamp & more");
assert.equal(f.canonical, "https://a.com/x/");
assert.deepEqual(f.h2, ["Prices", "Booking"], "nav, header, desker headings must not pollute");
assert.deepEqual(f.h3, ["What is included?"]);
assert.ok(f.wordCount >= 300 && f.wordCount < 320, `wordCount ${f.wordCount}`);
assert.deepEqual(f.schemaTypes.sort(), ["FAQPage", "LocalBusiness", "Service", "Thing"]);
assert.equal(f.faq.schema, true);
assert.equal(f.links.internal, 2);
assert.equal(f.links.external, 2, "ext.com + wa.me");
assert.deepEqual(f.images, { count: 2, withAlt: 1 });
assert.ok(f.price.count >= 1);
assert.equal(f.contact.tel, true);
assert.equal(f.contact.whatsapp, true);
assert.equal(f.pageType, "service or product");

// blocked pages
const challenge = buildPageFacts({ url: "https://b.com/", finalUrl: "https://b.com/", status: 200, contentType: "text/html", html: "<html><head><title>Just a moment...</title></head><body>wait</body></html>" });
assert.equal(challenge.fetched, false);
assert.match(challenge.reason, /challenge/);
assert.match(buildPageFacts({ url: "u", finalUrl: "u", status: 403, contentType: "text/html", html: body(500) }).reason, /403/);
assert.match(buildPageFacts({ url: "u", finalUrl: "u", status: 200, contentType: "application/pdf", html: "" }).reason, /non html/);
assert.match(buildPageFacts({ url: "https://c.com/p/", finalUrl: "https://c.com/p/", status: 200, contentType: "text/html", html: "<body><p>tiny</p></body>" }).reason, /under 200/);
assert.equal(blockReason({ status: 200, contentType: "text/html", html: "" }, "x".repeat(400)), null);

// ASP.NET style: whole page inside one form must still count
const wrapped = buildPageFacts({ url: "https://w.com/p/", finalUrl: "https://w.com/p/", status: 200, contentType: "text/html", html: `<body><form id="f"><main><h1>T</h1><h2>Rooms</h2>${body(400)}</main></form><script src="recaptcha"></script></body>` });
assert.equal(wrapped.fetched, true);
assert.deepEqual(wrapped.h2, ["Rooms"]);

// domain class
assert.equal(classifyDomain("https://www.tripadvisor.com/x"), "directory");
assert.equal(classifyDomain("https://m.facebook.com/x"), "social");
assert.equal(classifyDomain("https://www.expedia.com/x"), "aggregator");
assert.equal(classifyDomain("https://shop.mine.com/x", { own: ["mine.com"] }), "own");
assert.equal(classifyDomain("https://foo.co.uk/x", { directories: ["foo.co.uk"] }), "directory");
assert.equal(classifyDomain("https://random.com/x"), "site");
assert.equal(regDomain("www.shop.co.uk"), "shop.co.uk");

// ---- consensus ----
assert.equal(median([1, 3, 2]), 2);
assert.equal(median([1, 2, 3, 4]), 3);
assert.equal(threshold(10), 4);
assert.equal(threshold(4), 3);
assert.deepEqual([...ngrams("The Best Desk Lamp in Paris")].sort(), ["best", "best desk", "best desk lamp", "desk", "desk lamp", "desk lamp paris", "lamp", "lamp paris", "paris"]);

const mk = (position, url, h2, extra = {}) => ({ position, url, fetched: true, domainClass: "site", pageType: "service or product", title: `Lamp Paris ${position}`, metaDescription: "lamp paris deals", wordCount: 1000 + position * 100, h2, h3: [], schemaTypes: ["LocalBusiness"], images: { count: 5 }, faq: { signal: false }, price: { count: 1 }, contact: { whatsapp: true, tel: false }, ...extra });
const pages = [
  mk(1, "https://a.com/", ["Prices", "Booking"]),
  mk(2, "https://b.com/", ["Our prices", "How booking works"]),
  mk(3, "https://c.com/", ["Price list", "Booking steps"]),
  mk(4, "https://d.com/", ["Prices today", "Safety"]),
  { position: 5, url: "https://e.com/", fetched: false, reason: "http 403", domainClass: "site" },
];
const serp = { organic: pages, features: { peopleAlsoAsk: [{ question: "q" }], localPack: [], answerBox: null } };
const cons = consensus("lamp paris", serp, pages);
assert.equal(cons.competitorsUsed, 4, "unfetched excluded");
assert.equal(cons.wordCount.median, 1250, "median over fetched only");
assert.equal(cons.wordCount.min, 1100);
assert.equal(cons.unfetched.length, 1);
assert.equal(cons.termThreshold, 3);
assert.ok(cons.headingTerms.find((t) => t.term === "prices" && t.count === 3), JSON.stringify(cons.headingTerms));
assert.ok(cons.headingTerms.find((t) => t.term === "booking" && t.count === 3));
assert.equal(cons.titles.shareExactQuery, 1);
assert.deepEqual(cons.features, ["peopleAlsoAsk"]);
assert.equal(termConsensus([["a b"], ["a b"]], 3).length, 0);

const gapOwn = { fetched: true, url: "https://me.com/", h1: ["Lamp"], h2: ["Prices"], h3: [], wordCount: 700, schemaTypes: [], title: "x", metaDescription: "", faq: { signal: false }, pageType: "service or product" };
const gap = ownGap(cons, gapOwn, 7, "lamp paris");
assert.ok(gap.missingHeadingTerms.some((t) => t.term === "booking"));
assert.ok(!gap.missingHeadingTerms.some((t) => t.term === "prices"));
assert.equal(gap.missingSchemaTypes[0].type, "LocalBusiness");
assert.equal(gap.wordDelta, -550);
assert.equal(gap.queryInTitle, false);
assert.equal(ownGap(cons, null, null, "q").status, "no page");

// ---- overlap + clusters ----
const org = (...u) => u.map((x, i) => ({ position: i + 1, url: x }));
const s1 = { query: "q1", organic: org("https://a.com/1", "https://b.com/", "https://c.com/", "https://d.com/", "https://e.com/") };
const s2 = { query: "q2", organic: org("https://www.a.com/1/", "https://b.com/", "https://c.com/", "https://d.com/", "https://z.com/") };
const s3 = { query: "q3", organic: org("https://a.com/other", "https://y.com/", "https://x.com/", "https://w.com/", "https://v.com/") };
const pairs = overlapMatrix([s1, s2, s3]);
assert.equal(pairs.find((p) => p.a === "q1" && p.b === "q2").sharedUrls, 4, "www and trailing slash normalised");
assert.equal(pairs.find((p) => p.a === "q1" && p.b === "q3").sharedUrls, 0);
assert.equal(pairs.find((p) => p.a === "q1" && p.b === "q3").sharedDomains, 1);
const cl = clusterQueries(["q1", "q2", "q3"], pairs, 4);
assert.deepEqual(cl.map((c) => c.queries), [["q1", "q2"], ["q3"]]);
const chain = clusterQueries(["a", "b", "c"], [{ a: "a", b: "b", sharedUrls: 5 }, { a: "b", b: "c", sharedUrls: 5 }, { a: "a", b: "c", sharedUrls: 0 }], 4);
assert.equal(chain.length, 2, "complete linkage does not chain a-b-c when a-c is 0");
const tri = [{ a: "blue", b: "oil", sharedUrls: 4 }, { a: "oil", b: "couples", sharedUrls: 5 }, { a: "blue", b: "couples", sharedUrls: 2 }];
const triCl = clusterQueries(["blue", "oil", "couples"], tri, 4);
assert.ok(!triCl.some((c) => c.queries.length === 3), "no cluster holds all three");
assert.deepEqual(triCl.map((c) => c.queries), [["blue"], ["oil", "couples"]]);
const bl = borderlinePairs(tri, triCl, 4);
assert.deepEqual(bl.map((p) => `${p.a}+${p.b}`), ["blue+oil"], "blue+oil at threshold but split; no pair exactly 1 below");
assert.deepEqual(borderlinePairs([{ a: "x", b: "y", sharedUrls: 3 }], [{ id: 1, queries: ["x"] }, { id: 2, queries: ["y"] }], 4).map((p) => p.kind), ["1 below threshold"]);
// port is kept in URL normalisation
assert.notEqual(overlapMatrix([{ query: "p", organic: org("https://a.com:8080/x") }, { query: "r", organic: org("https://a.com/x") }])[0].sharedUrls, 1, "ports not dropped");
// reddit style js challenge shell is a bot challenge, not "empty"
assert.equal(blockReason({ status: 200, contentType: "text/html", html: '<form hidden><input name="js_challenge" value="1"></form>' }, "Reddit"), "bot challenge page");

// ---- diff ----
const prev = { organic: org("https://me.com/p", "https://a.com/", "https://b.com/") };
const cur = { organic: org("https://a.com/", "https://me.com/p", "https://n.com/") };
const d = diffSerps(prev, cur, ["me.com"]);
assert.deepEqual(d.newUrls.map((u) => u.url), ["https://n.com/"]);
assert.deepEqual(d.droppedUrls.map((u) => u.url), ["https://b.com/"]);
assert.equal(d.moves.length, 2);
assert.equal(d.ownBefore, 1);
assert.equal(d.ownAfter, 2);

// ---- metrics parsing ----
const m1 = parseMetrics('keyword,volume,difficulty,cpc\n"lamp, paris",1200,35,0.8\nfoo,10,,\n', true);
assert.equal(m1.get("lamp, paris").volume, 1200);
assert.equal(m1.get("foo").difficulty, null);
const m2 = parseMetrics('[{"keyword":"Foo","volume":5,"difficulty":1,"cpc":2}]', false);
assert.equal(m2.get("foo").cpc, 2);

// ---- ads response mapping (fixture, no network) ----
const adsMap = mapAdsResponse({ results: [
  { text: "Desk Lamp Paris", keywordMetrics: { avgMonthlySearches: "1300", competition: "HIGH", competitionIndex: "78", lowTopOfPageBidMicros: "4500000", highTopOfPageBidMicros: "12340000" } },
  { text: "no data kw", keywordMetrics: { competition: "UNSPECIFIED" } },
  { keywordMetrics: {} },
] });
assert.equal(adsMap.size, 2);
const am = adsMap.get("desk lamp paris");
assert.deepEqual([am.volume, am.competition, am.competitionIndex, am.cpcLow, am.cpcHigh, am.cpc], [1300, "HIGH", 78, 4.5, 12.34, 12.34]);
assert.equal(adsMap.get("no data kw").volume, null);
assert.equal(adsMap.get("no data kw").competition, null);
const rt = parseMetrics(JSON.stringify(metricsToRows(adsMap)), false);
assert.equal(rt.get("desk lamp paris").cpcHigh, 12.34, "metrics.json round trip");
assert.equal(rt.get("desk lamp paris").competition, "HIGH");
assert.deepEqual(adsTargets("us", "en"), { geo: "geoTargetConstants/2840", language: "languageConstants/1000" });
assert.throws(() => adsTargets("zz", "en"), /--gl "zz"/);
assert.throws(() => adsTargets("us", "xx"), /--hl "xx"/);

// ---- security guards ----
for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:a00:1"]) assert.equal(isPrivateIp(ip), true, ip);
for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
for (const u of ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/", "http://192.168.0.1/"]) {
  const r = await fetchPage(u, { retries: 0 });
  assert.equal(r.blocked, "private-host", u);
  assert.equal(buildPageFacts(r).reason, "private-host");
}
assert.equal((await fetchPage("file:///etc/passwd", { retries: 0 })).blocked, "bad-scheme");
assert.equal(adsAvailable(process.cwd(), undefined), "no --ads-client <path> given");
process.env.GADS_ACCOUNT = "1234567890";
const red = redactError(`boom 1234567890 tok ${"A".repeat(40)} ${"x".repeat(400)}`);
assert.ok(!red.includes("1234567890") && !red.includes("AAAAAAAA") && red.length <= 300, "redaction");
delete process.env.GADS_ACCOUNT;

console.log("serp-teardown tests passed");
