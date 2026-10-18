// lint-env --fix: D4 comment rewrite plan and the names + value digest guard.
// Values are read only inside envDigest, hashed, and never returned or printed.
import crypto from "node:crypto";
import { commentReasons } from "./envparse.mjs";

const BANNER = /^#\s*===\s*(.+?)\s*===\s*$/;
const KEY = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const COMMENTED_KEY = /^#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
// Long runs of key-ish characters with letters and digits: treated as a possible value.
const VALUEISH = /[A-Za-z0-9+/=_.-]{24,}/g;

const keyName = (line) => {
  const t = line.trim();
  if (t.startsWith("#")) return null;
  const m = t.match(KEY);
  return m ? m[1] : null;
};

// Sorted name list + sha256 of the sorted name=value lines (duplicates kept, last write order ignored).
export function envDigest(text) {
  const entries = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const name = keyName(line);
    if (!name) continue;
    const t = line.trim().replace(/^export\s+/, "");
    entries.push(`${name}\0${t.slice(t.indexOf("=") + 1)}`);
  }
  entries.sort();
  const h = crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
  return { names: entries.map((e) => e.slice(0, e.indexOf("\0"))), hash: h };
}

// Comment text for the diff: commented out key lines are masked, never shown with their value side.
export function maskComment(line) {
  const t = line.trim();
  const m = t.match(COMMENTED_KEY);
  return m ? `# ${m[1]}=<value>` : t;
}

// Repo relative file paths with a known extension (optional trailing period) are not values.
const FILE_PATH = /^[A-Za-z0-9~._-]+(\/[A-Za-z0-9._-]+)+\.(md|mjs|cjs|js|ts|json|sh|astro|toml|ya?ml|csv)\.?$/;

export function looksLikeValue(s) {
  for (const m of s.matchAll(VALUEISH)) if (/[A-Za-z]/.test(m[0]) && /\d/.test(m[0]) && !FILE_PATH.test(m[0])) return true;
  return false;
}

const cleanPurpose = (p) => {
  const s = (p || "").replace(/`/g, "").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
  if (!s || s.includes("#") || commentReasons(s).length || s.split(" ").length > 8) return "";
  return s;
};

// Plan the rewrite. purposeOf(name) = ledger purpose or "". Returns { text, changes, unfixed }.
// changes: { line, name|null, old: [comment lines], new: comment line|null }.
export function planFix(text, purposeOf) {
  const lines = text.split("\n");
  const out = [];
  const changes = [];
  const unfixed = [];
  let pending = [];
  let seenBanner = false;
  const dropPending = () => {
    if (pending.length) changes.push({ line: pending[0].n, name: null, old: pending.map((p) => p.raw), new: null });
    pending = [];
  };
  lines.forEach((raw, i) => {
    const n = i + 1;
    const t = raw.trim();
    if (t.startsWith("#") && !BANNER.test(t)) {
      pending.push({ n, raw });
      return;
    }
    const name = t ? keyName(raw) : null;
    if (!name) {
      dropPending();
      if (BANNER.test(t)) seenBanner = true;
      out.push(raw);
      return;
    }
    if (!seenBanner) unfixed.push({ line: n, name, why: "key before the first group banner (move by hand)" });
    const reasons = new Set();
    if (pending.length > 1) reasons.add("multi line");
    pending.forEach((p) => commentReasons(p.raw).forEach((r) => reasons.add(r)));
    if (!reasons.size) {
      pending.forEach((p) => out.push(p.raw));
      pending = [];
      out.push(raw);
      return;
    }
    const first = pending.length ? pending[0].raw.trim().replace(/^#\s*/, "").replace(/,?\s*ledger:.*$/i, "") : "";
    const purpose = cleanPurpose(purposeOf(name)) || cleanPurpose(first) || "purpose open";
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = `# ${purpose}, ledger: ${name}${cr}`;
    changes.push({ line: pending[0].n, name, old: pending.map((p) => p.raw), new: line });
    pending = [];
    out.push(line, raw);
  });
  dropPending();
  return { text: out.join("\n"), changes, unfixed };
}

// Every non comment line, in order. Must be identical before and after a plan.
export const keyLines = (text) => text.split("\n").filter((l) => !(l.trim().startsWith("#") && !BANNER.test(l.trim())));
