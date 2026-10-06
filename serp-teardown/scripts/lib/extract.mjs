// extract.mjs: fetch a page and turn HTML into plain facts. Node stdlib only.
// Regex based on purpose. economy: main content detection and word count use regexes, not a DOM
// parser. Ceiling: nested nav/header/aside blocks, unclosed tags and heavily JS rendered pages give
// rough numbers. Upgrade path: swap stripNoise()/mainRegion() for a DOM parser (linkedom or parse5)
// and keep the same returned shape.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const SOCIAL = ["facebook.com", "instagram.com", "youtube.com", "tiktok.com", "x.com", "twitter.com", "pinterest.com", "linkedin.com", "reddit.com", "quora.com", "medium.com"];
const AGGREGATOR = ["booking.com", "expedia.com", "getyourguide.com", "viator.com", "trip.com", "hotels.com", "airbnb.com", "kayak.com"];
const DIRECTORY = ["tripadvisor.com", "yelp.com", "timeout.com", "wikipedia.org", "foursquare.com", "yellowpages.com", "lonelyplanet.com", "thrillist.com", "trustpilot.com", "mapquest.com", "groupon.com", "justdial.com", "clutch.co", "g2.com", "bbb.org"];

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "go", "or", "gov", "edu"]);

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// registrable-ish domain: last 2 labels, last 3 for co.uk style
export function regDomain(host) {
  const parts = String(host || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2);
  if (last2[1].length === 2 && SECOND_LEVEL.has(last2[0])) return parts.slice(-3).join(".");
  return last2.join(".");
}

export function hostMatches(host, domain) {
  const h = String(host || "").replace(/^www\./, "");
  const d = String(domain || "").toLowerCase().replace(/^www\./, "");
  return !!d && (h === d || h.endsWith("." + d));
}

export function classifyDomain(url, { own = [], directories = [] } = {}) {
  const host = hostOf(url);
  if (own.some((d) => hostMatches(host, d))) return "own";
  const reg = regDomain(host);
  if (SOCIAL.includes(reg)) return "social";
  if (AGGREGATOR.includes(reg)) return "aggregator";
  if (DIRECTORY.includes(reg) || directories.some((d) => hostMatches(host, d))) return "directory";
  return "site";
}

export function decode(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChr(Number(d)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}
function safeChr(n) {
  try { return String.fromCodePoint(n); } catch { return " "; }
}

export function textOf(html) {
  return decode(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]);
}

function metaContent(html, key, attr = "name") {
  for (const t of tags(html, "meta")) {
    const a = attrs(t);
    if ((a[attr] || "").toLowerCase() === key) return decode(a.content || "").replace(/\s+/g, " ").trim();
  }
  return "";
}

function stripBlocks(html, names) {
  let out = html;
  for (const n of names) out = out.replace(new RegExp(`<${n}\\b[^>]*>[\\s\\S]*?</${n}>`, "gi"), " ");
  return out;
}

export function stripNoise(html) {
  return stripBlocks(String(html).replace(/<!--[\s\S]*?-->/g, " "), ["script", "style", "noscript", "svg", "template", "iframe"]);
}

// main region: <main>, else <article>, else <body>; then nav/header/footer/aside/form removed
export function mainRegion(cleanHtml) {
  const pick = (name) => {
    const m = cleanHtml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
    return m ? m[1] : null;
  };
  const bodyHtml = pick("body") ?? cleanHtml;
  const bodyLen = textOf(bodyHtml).length;
  // main/article only when it holds a real share (30 pct) of the page text (some sites put one teaser block in <article>)
  const good = (r) => r && textOf(r).length >= 200 && textOf(r).length >= bodyLen * 0.3;
  let region = pick("main");
  let source = "main";
  if (!good(region)) {
    const art = pick("article");
    if (good(art)) { region = art; source = "article"; }
    else { region = bodyHtml; source = "body"; }
  }
  const lean = stripBlocks(region, ["nav", "header", "footer", "aside"]);
  // ASP.NET style sites wrap the whole page in one <form>: only drop forms when that keeps most of the text
  const noForm = stripBlocks(lean, ["form"]);
  return { html: textOf(noForm).length >= textOf(lean).length * 0.5 ? noForm : lean, source };
}

function headings(regionHtml, level) {
  return [...regionHtml.matchAll(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, "gi"))]
    .map((m) => textOf(m[1]))
    .filter(Boolean);
}

function jsonLdTypes(html) {
  const types = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      if (node["@type"]) types.push(...[].concat(node["@type"]).map(String));
      if (node["@graph"]) walk(node["@graph"]);
    };
    walk(parsed);
  }
  return [...new Set(types)];
}

const PRICE_RE = /(?:USD|EUR|GBP|\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]{1,6}\s?(?:USD|EUR|GBP)/gi;
const QUESTION_START = /^(what|how|where|when|why|who|which|can|does|do|is|are|should|will|am|may)\b/i;

function linkCounts(html, pageUrl) {
  const host = hostOf(pageUrl);
  let internal = 0, external = 0;
  for (const t of tags(html, "a")) {
    const href = (attrs(t).href || "").trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel|sms|whatsapp):/i.test(href)) continue;
    if (/^https?:\/\//i.test(href) || href.startsWith("//")) {
      const h = hostOf(href.startsWith("//") ? "https:" + href : href);
      if (h && host && (h === host || hostMatches(h, regDomain(host)))) internal++;
      else external++;
    } else internal++;
  }
  return { internal, external };
}

function pageType({ url, schemaTypes, title, h1, host, domainClass }) {
  let path = "/";
  try { path = new URL(url).pathname; } catch { /* keep default */ }
  const lowerPath = path.toLowerCase();
  const types = schemaTypes.map((t) => t.toLowerCase());
  if (path === "/" || path === "") return "home";
  if (domainClass === "directory" || domainClass === "aggregator") return "listing or directory";
  if (types.some((t) => /article|blogposting|newsarticle/.test(t)) || /\/(blog|news|article|articles|guide|guides|post|posts|magazine|stories)\//.test(lowerPath)) return "article";
  if (types.includes("itemlist") || /\b(top|best)\s+\d+\b|^\d+\s+best\b/i.test(title) || /\/(best|top)-/.test(lowerPath) || /\/(directory|listings?|search|category|categories)\//.test(lowerPath)) return "listing or directory";
  if (/\/(locations?|areas?|districts?|city|cities|near|in)\b/.test(lowerPath) || types.includes("place") || types.includes("city")) return "location";
  return "service or product";
}

const MAX_BODY = 2_000_000; // bytes read from any page
const MAX_REDIRECTS = 5;

function v4Private(parts) {
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// true for loopback, unspecified, link local, RFC1918 and unique local addresses (v4, v6, v4 mapped v6)
export function isPrivateIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip.split(".").map(Number));
  if (kind !== 6) return true; // not an IP at all: refuse
  let h = ip.toLowerCase().split("%")[0];
  const dotted = h.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1].split(".").map(Number);
    h = h.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail = null] = h.split("::");
  const hs = head ? head.split(":") : [];
  const ts = tail ? tail.split(":") : [];
  const g = tail === null ? hs : [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill("0"), ...ts];
  const w = g.map((x) => parseInt(x || "0", 16));
  if (w.length !== 8 || w.some(Number.isNaN)) return true;
  if (w.every((x) => x === 0)) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return v4Private([w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255]); // ::ffff:a.b.c.d
  return false;
}

// Returns null when the URL is allowed, else a reason string ("bad-scheme" or "private-host").
// Limit: the lookup and the later connect resolve separately (DNS rebinding window); stdlib fetch cannot pin the address.
async function urlGuard(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "bad-scheme";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateIp(host) ? "private-host" : null;
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || addrs.some((x) => isPrivateIp(x.address))) return "private-host";
  } catch (e) {
    return null; // unresolvable: let fetch report the real error
  }
  return null;
}

async function readCapped(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BODY - total;
    const chunk = value.length > room ? value.subarray(0, room) : value;
    chunks.push(chunk);
    total += chunk.length;
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export async function fetchPage(url, { timeoutMs = 15000, retries = 1 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let current = url;
      let res = null;
      for (let hop = 0; ; hop++) {
        let u;
        try { u = new URL(current); } catch { return { url, status: null, finalUrl: url, contentType: "", html: "", error: "invalid url", blocked: null }; }
        const bad = await urlGuard(u);
        if (bad) return { url, status: null, finalUrl: current, contentType: "", html: "", error: null, blocked: bad };
        res = await fetch(u, {
          headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const loc = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && loc) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          if (hop >= MAX_REDIRECTS) return { url, status: null, finalUrl: current, contentType: "", html: "", error: "too many redirects", blocked: null };
          current = new URL(loc, u).href;
          continue;
        }
        break;
      }
      const finalUrl = current;
      const contentType = res.headers.get("content-type") || "";
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > MAX_BODY) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        last = { url, status: res.status, finalUrl, contentType, html: "", error: "response over 2 MB", blocked: null };
        return last;
      }
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim())) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        last = { url, status: res.status, finalUrl, contentType, html: "", error: contentType ? null : "missing content-type", blocked: null };
        return last;
      }
      const body = await readCapped(res);
      last = { url, status: res.status, finalUrl, contentType, html: body, error: null, blocked: null };
      if (res.status >= 500 && res.status !== 503 && attempt < retries) { await sleep(1000); continue; }
      return last;
    } catch (err) {
      last = { url, status: null, finalUrl: url, contentType: "", html: "", error: err?.name === "TimeoutError" ? "timeout" : String(err?.message || err), blocked: null };
      if (attempt < retries) await sleep(1000);
    }
  }
  return last;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHALLENGE_HARD = [/<title[^>]*>\s*(just a moment|attention required|access denied|are you a robot|robot check|pardon our interruption)/i, /__cf_chl_/i, /cf-browser-verification/i, /cf-challenge/i, /name="js_challenge"/i];
const CHALLENGE_SOFT = /(verify you are human|checking your browser|enable javascript and cookies|unusual traffic|px-captcha|captcha-delivery|access denied|are you a robot)/i;

// Returns a reason string when the response is unusable, else null.
export function blockReason(res, text) {
  if (res.blocked) return res.blocked;
  if (res.error) return `fetch error: ${res.error}`;
  if (res.status === 403 || res.status === 429 || res.status === 503) return `http ${res.status}`;
  if (res.status == null || res.status >= 400) return `http ${res.status}`;
  if (res.contentType && !/html/i.test(res.contentType)) return `non html content-type: ${res.contentType.split(";")[0]}`;
  if (CHALLENGE_HARD.some((re) => re.test(res.html))) return "bot challenge page";
  // soft markers (captcha scripts are common on real pages) only count for small, thin pages
  const small = res.html.length < 40000;
  if (text.length < 200) return small && CHALLENGE_SOFT.test(res.html) ? "bot challenge page" : "body text under 200 chars (empty or JS rendered)";
  if (text.length < 1500 && small && CHALLENGE_SOFT.test(res.html)) return "bot challenge page";
  return null;
}

// res = fetchPage() output. ctx = { own: [domains], directories: [domains] }
export function buildPageFacts(res, ctx = {}) {
  const base = { url: res.url, finalUrl: res.finalUrl, status: res.status };
  // The scanners below are lazy regexes on bounded input: HTML is sliced to 1 MB so a hostile page cannot stall them.
  const html = (res.html || "").slice(0, 1_000_000);
  const clean = stripNoise(html);
  const region = mainRegion(clean);
  const text = textOf(region.html);
  const reason = blockReason(res, text);
  const domainClass = classifyDomain(res.finalUrl || res.url, ctx);
  if (reason) return { ...base, fetched: false, reason, domain: regDomain(hostOf(res.finalUrl || res.url)), domainClass };

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").replace(/\s+/g, " ").trim();
  let canonical = "";
  for (const t of tags(html, "link")) {
    const a = attrs(t);
    if (/\bcanonical\b/i.test(a.rel || "")) { canonical = a.href || ""; break; }
  }
  const h1 = headings(region.html, 1).length ? headings(region.html, 1) : headings(clean, 1);
  const h2 = headings(region.html, 2);
  const h3 = headings(region.html, 3);
  const h4 = headings(region.html, 4);
  const schemaTypes = jsonLdTypes(html);
  const imgs = tags(html, "img").map(attrs);
  const prices = html.match(PRICE_RE) || [];
  const questionHeadings = [...h2, ...h3, ...h4].filter((h) => /\?\s*$/.test(h) || QUESTION_START.test(h)).length;
  const hasForm = /<form\b/i.test(html) && /<(input|textarea|select)\b/i.test(html) && /(book|reserv|enquir|inquir|appointment|contact)/i.test(html);
  const host = hostOf(res.finalUrl || res.url);

  return {
    ...base,
    fetched: true,
    reason: null,
    domain: regDomain(host),
    domainClass,
    title,
    metaDescription: metaContent(html, "description"),
    canonical,
    robots: metaContent(html, "robots"),
    h1, h2, h3,
    wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
    contentSource: region.source,
    schemaTypes,
    links: linkCounts(html, res.finalUrl || res.url),
    images: { count: imgs.length, withAlt: imgs.filter((a) => (a.alt || "").trim()).length },
    faq: { schema: schemaTypes.includes("FAQPage"), questionHeadings, signal: schemaTypes.includes("FAQPage") || questionHeadings >= 3 },
    price: { count: prices.length, sample: prices.slice(0, 3) },
    contact: {
      tel: /href=["']?tel:/i.test(html),
      whatsapp: /(wa\.me\/|api\.whatsapp\.com|whatsapp:\/\/|href=["'][^"']*whatsapp)/i.test(html),
      form: hasForm,
    },
    pageType: pageType({ url: res.finalUrl || res.url, schemaTypes, title, domainClass }),
  };
}

// small concurrency pool: runs worker(item) with at most `limit` in flight, keeps order
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
