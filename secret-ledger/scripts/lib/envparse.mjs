// Env file parser, names only. The value side of a line is never extracted.
import { ENVS } from "./defaults.mjs";
import { LedgerError } from "./config.mjs";

const BANNER = /^#\s*===\s*(.+?)\s*===\s*$/;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_RES = [
  /\b\d{4}-\d{2}(?:-\d{2})?\b/,
  new RegExp(`\\b${MONTH}\\s+\\d{1,4}\\b`, "i"),
  new RegExp(`\\b\\d{1,2}\\s+${MONTH}(?:\\s|$)`, "i"),
];

// D4 comment rule reasons for one comment line; the text itself is dropped by the caller.
export function commentReasons(text) {
  const r = [];
  if (DATE_RES.some((re) => re.test(text))) r.push("date");
  if (/http/i.test(text)) r.push("url");
  if (/expires/i.test(text)) r.push("expires");
  return r;
}

export const bannerEnv = (banner) => {
  const last = (banner || "").trim().split(/\s+/).pop()?.toUpperCase() || "";
  return ENVS.includes(last) ? last : "";
};

export function parseEnv(text) {
  const keys = new Map(); // name -> { name, line, banner, bannerEnv, commentLines, reasons }
  const duplicates = [];
  const malformed = [];
  const loose = [];
  const beforeBanner = [];
  let banner = null;
  let pending = [];
  const flush = () => {
    loose.push(...pending.map((p) => p.line));
    pending = [];
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const t = raw.trim();
    if (!t) return flush();
    if (t.startsWith("#")) {
      const h = t.match(BANNER);
      if (h) {
        flush();
        banner = h[1];
        return;
      }
      pending.push({ line: n, reasons: commentReasons(t) });
      return;
    }
    const body = t.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    const name = eq > 0 ? body.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      malformed.push(n);
      flush();
      return;
    }
    const reasons = new Set();
    if (pending.length > 1) reasons.add("multi line");
    for (const p of pending) p.reasons.forEach((x) => reasons.add(x));
    const rec = { name, line: n, banner, bannerEnv: bannerEnv(banner), commentLines: pending.map((p) => p.line), reasons: [...reasons] };
    pending = [];
    if (banner === null) beforeBanner.push({ name, line: n });
    if (keys.has(name)) duplicates.push({ name, line: n, first: keys.get(name).line });
    keys.set(name, rec); // last definition wins
  });
  flush();
  return { keys, duplicates, malformed, loose, beforeBanner };
}

// sha12 of a value (D7) is P6 work.
export function sha12() {
  throw new Error("sha12: not in P1");
}

// Set the single comment line directly above `name` (last definition). Returns the new text, the
// same text when unchanged, or null when the key is absent. Throws (exit 2) if any line other than
// that comment would change.
export function setKeyComment(text, name, comment) {
  if (/[\r\n]/.test(comment)) throw new LedgerError("env comment: one line only");
  const lines = text.split("\n");
  const isKey = (l) => {
    const t = l.trim();
    if (t.startsWith("#")) return false;
    const b = t.replace(/^export\s+/, "");
    const eq = b.indexOf("=");
    return eq > 0 && b.slice(0, eq).trim() === name;
  };
  let k = -1;
  lines.forEach((l, i) => isKey(l) && (k = i));
  if (k < 0) return null;
  const line = `# ${comment}${lines[k].endsWith("\r") ? "\r" : ""}`;
  const above = k > 0 ? lines[k - 1].trim() : "";
  const replace = above.startsWith("#") && !BANNER.test(above);
  if (replace && lines[k - 1] === line) return text;
  const out = [...lines];
  if (replace) out[k - 1] = line;
  else out.splice(k, 0, line);
  const back = [...out];
  if (replace) back[k - 1] = lines[k - 1];
  else back.splice(k, 1);
  if (out[replace ? k : k + 1] !== lines[k] || back.join("\n") !== text) throw new LedgerError("env write refused: the key line would change");
  return out.join("\n");
}
